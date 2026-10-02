/* Atmosphere: Unreal-style exponential height fog with directional (sun) in-scattering, and a sky
 * whose horizon is evaluated with the very same fog function, so distant geometry and the sky meet
 * with no seam.
 *
 * Wiring (three.js r128):
 *  - THREE.ShaderChunk.fog_* are patched once, before any material compiles, so every built-in
 *    material with fog: true (standard / basic / line / points, instanced or not, including the
 *    onBeforeCompile facade materials, which only rewrite other chunks) gets the new fog.
 *  - The fog keeps THREE's own `fogColor` and `fogDensity` uniforms (refreshed by the renderer from
 *    scene.fog for every fogged material). fogColor is the haze colour away from the sun and
 *    fogDensity is the extinction coefficient (1/m) at sea level.
 *  - The extra parameters live in four shared Float32Array(4) uniforms (smFogCam, smFogSun,
 *    smFogScat, smFogHeight) that are added to every ShaderLib entry that has fog uniforms.
 *    UniformsUtils.clone() deep-copies Vector/Color values but passes typed arrays through by
 *    reference, so every material's uniform points at the same buffer: writing the buffer once per
 *    frame updates all materials, and the renderer re-uploads them whenever it binds a material.
 *    No per-material onBeforeCompile hook, no renderer monkey-patching.
 *  - The camera position is passed in smFogCam rather than the built-in cameraPosition, because
 *    r128 only sets cameraPosition for Standard/Phong/Toon/Shader materials (or with an envMap),
 *    not for MeshBasicMaterial or LineBasicMaterial.
 *  - Values are written in scene.onBeforeRender, which runs inside renderer.render(): after the
 *    engine's updateAtmosphere() has written scene.fog for the frame, and for whichever camera is
 *    actually rendering. The plugin update() only smooths the in-cloud whiteout.
 */
window.SM_PLUGINS = window.SM_PLUGINS || [];
window.SM_PLUGINS.push(function atmosphere(ctx) {
  'use strict';
  const { THREE, scene, renderer, SUN_DIR, skyMat } = ctx;
  if (!scene.fog) scene.fog = new THREE.FogExp2(0xffffff, 0.0009);

  // ---------------------------------------------------------------- tuning (linear HDR, metres)
  const P = {
    density: 0.0009,        // extinction at sea level, 1/m (fogDensity)
    falloff: 1 / 420,       // height falloff, 1/m: density halves every ~290 m
    baseY: 0,               // height where density == P.density
    start: 150,             // no fog nearer than this (street-level blocks stay crisp)
    maxOpacity: 1.0,
    g: 0.72,                // Henyey-Greenstein anisotropy of the sharp sun lobe
    awayCol: [0.60, 0.60, 0.68],   // haze with the sun behind you: pale, slightly cool
    sunCol: [2.0, 1.25, 0.62],     // haze looking into the sun: golden, HDR (feeds bloom)
    spaceCol: [0.084, 0.25, 0.96], // HOR1 from the engine (pow 2.2, x1.15) for the space transition
    cloudDensity: 0.02,     // in-cloud whiteout (art bible: fog density +0.02 in cloud)
    skyDist: 60000          // distance at which the sky is fogged (the "horizon")
  };

  // ---------------------------------------------------------------- shared uniforms
  const U = {
    smFogCam: { value: new Float32Array(4) },     // xyz camera world position, w max opacity
    smFogSun: { value: new Float32Array(4) },     // xyz sun direction, w HG g
    smFogScat: { value: new Float32Array(4) },    // rgb sun in-scatter colour, w start distance
    smFogHeight: { value: new Float32Array(4) }   // x falloff, y base height, z cloud density, w unused
  };
  for (const k in THREE.ShaderLib) {
    const sh = THREE.ShaderLib[k];
    if (sh && sh.uniforms && sh.uniforms.fogColor) for (const n in U) sh.uniforms[n] = U[n];
  }

  // ---------------------------------------------------------------- GLSL
  // Integral of rho(h) = fogDensity * exp(-falloff * (h - baseY)) along the camera ray, starting at
  // `start` metres (Unreal's ExponentialHeightFog). Written as the difference of two exponentials of
  // absolute heights so a camera 100 km up looking down never overflows float32.
  const FOG_FN = `
uniform vec4 smFogCam;
uniform vec4 smFogSun;
uniform vec4 smFogScat;
uniform vec4 smFogHeight;
float smFogOD( vec3 ray ) {
  float L = length( ray );
  float Ls = max( L - smFogScat.w, 0.0 );
  float t0 = 1.0 - Ls / max( L, 1e-3 );
  float hs = max( smFogCam.y + ray.y * t0 - smFogHeight.y, -60.0 );
  float dy = ray.y * ( 1.0 - t0 );
  float he = max( hs + dy, -60.0 );
  float b = smFogHeight.x;
  float bdy = b * ( he - hs );
  float es = exp( - b * hs );
  float seg = abs( bdy ) > 1e-3 ? ( es - exp( - b * he ) ) / bdy : es * ( 1.0 - 0.5 * bdy );
  return fogDensity * Ls * seg + smFogHeight.z * L;
}
vec3 smFogColor( vec3 dir ) {
  float c = dot( dir, smFogSun.xyz );
  float g = smFogSun.w;
  // sharp HG lobe (glare around the sun) plus a wide one (warmth across the sun's half of the sky),
  // both normalised to 1 looking straight at the sun
  float hs = ( 1.0 - g * g ) / pow( max( 1.0 + g * g - 2.0 * g * c, 1e-4 ), 1.5 ) * ( 1.0 - g ) * ( 1.0 - g ) / ( 1.0 + g );
  const float gw = 0.25;
  float hw = ( 1.0 - gw * gw ) / pow( 1.0 + gw * gw - 2.0 * gw * c, 1.5 ) * ( 1.0 - gw ) * ( 1.0 - gw ) / ( 1.0 + gw );
  float w = clamp( 0.3 * hw + 0.7 * hs, 0.0, 1.0 );
  return mix( fogColor, smFogScat.rgb, w );
}
vec4 smHeightFog( vec3 ray ) {
  float a = min( 1.0 - exp( - smFogOD( ray ) ), smFogCam.w );
  return vec4( smFogColor( normalize( ray ) ), a );
}
`;

  const C = THREE.ShaderChunk;
  C.fog_pars_vertex = `#ifdef USE_FOG
	varying float fogDepth;
	varying vec3 vFogWorldPos;
#endif`;
  C.fog_vertex = `#ifdef USE_FOG
	fogDepth = - mvPosition.z;
	{
		vec4 smFogWP = vec4( transformed, 1.0 );
		#ifdef USE_INSTANCING
			smFogWP = instanceMatrix * smFogWP;
		#endif
		vFogWorldPos = ( modelMatrix * smFogWP ).xyz;
	}
#endif`;
  C.fog_pars_fragment = `#ifdef USE_FOG
	uniform vec3 fogColor;
	uniform float fogDensity;
	varying float fogDepth;
	varying vec3 vFogWorldPos;
	#ifndef FOG_EXP2
		uniform float fogNear;
		uniform float fogFar;
	#endif
${FOG_FN}
#endif`;
  C.fog_fragment = `#ifdef USE_FOG
	vec4 smFog = smHeightFog( vFogWorldPos - smFogCam.xyz );
	gl_FragColor.rgb = mix( gl_FragColor.rgb, smFog.rgb, smFog.a );
#endif`;

  // ---------------------------------------------------------------- sky
  // Art-bible gradient as the clear-air (Rayleigh) term, a Henyey-Greenstein Mie aureole and the sun
  // disc, all in linear HDR; then the same height fog as the world, evaluated to skyDist along the
  // view ray. The horizon is therefore exactly the fog colour of geometry at that bearing, and the
  // sun disc is dimmed by the haze it shines through.
  const SKY_FS = [
    'uniform vec3 uSun; uniform float uSpace; uniform vec3 fogColor; uniform float fogDensity; uniform float uSkyDist;',
    'varying vec3 vDir;', '#include <common>', '#include <logdepthbuf_pars_fragment>',
    FOG_FN,
    'void main(){', '#include <logdepthbuf_fragment>',
    ' vec3 d=normalize(vDir); float y=d.y;',
    ' vec3 zen=mix(vec3(0.17,0.34,0.70),vec3(0.0,0.0,0.012),uSpace);',
    ' vec3 hor=mix(vec3(1.0,0.80,0.62),vec3(0.30,0.50,0.92),uSpace);',
    ' vec3 col=mix(hor,zen,pow(clamp(y,0.0,1.0),0.42));',
    ' if(y<0.0) col=mix(hor,mix(vec3(0.46,0.44,0.41),vec3(0.10,0.20,0.36),uSpace),clamp(-y*5.0,0.0,1.0));',
    ' col=pow(col,vec3(2.2))*1.15;',
    ' float c=dot(d,uSun);',
    ' col*=0.85+0.25*c*c;', // Rayleigh phase (1 + cos^2), mean kept near 1
    ' const float gm=0.82;',
    ' float mie=(1.0-gm*gm)/pow(1.0+gm*gm-2.0*gm*c,1.5)*(1.0-gm)*(1.0-gm)/(1.0+gm);',
    ' col+=vec3(2.6,1.3,0.5)*mie*0.45*(1.0-0.6*uSpace);',
    ' col+=mix(vec3(40.0,32.0,22.0),vec3(40.0,38.0,34.0),uSpace)*smoothstep(0.9993,0.9997,c);',
    ' vec4 f=smHeightFog(d*uSkyDist);',
    ' col=mix(col,f.rgb,f.a);',
    ' gl_FragColor=vec4(col,1.0);', '#include <encodings_fragment>', '}'
  ].join('\n');
  const skyFogDensity = { value: P.density };
  Object.assign(skyMat.uniforms, U, {
    fogColor: { value: scene.fog.color },   // the same Color object the renderer reads for fog
    fogDensity: skyFogDensity,
    uSkyDist: { value: P.skyDist }
  });
  skyMat.fragmentShader = SKY_FS;
  skyMat.needsUpdate = true;

  // ---------------------------------------------------------------- per-frame values
  const camPos = new THREE.Vector3();
  const awayC = new THREE.Color(), sunC = new THREE.Color();
  let cloud = 0;
  function write(cx, cy, cz, space) {
    const cam = U.smFogCam.value, sun = U.smFogSun.value, sc = U.smFogScat.value, hh = U.smFogHeight.value;
    cam[0] = cx; cam[1] = cy; cam[2] = cz; cam[3] = P.maxOpacity;
    sun[0] = SUN_DIR.x; sun[1] = SUN_DIR.y; sun[2] = SUN_DIR.z; sun[3] = P.g;
    const sk = 1 - 0.7 * space;
    sc[0] = P.sunCol[0] * sk; sc[1] = P.sunCol[1] * sk; sc[2] = P.sunCol[2] * sk; sc[3] = P.start;
    hh[0] = P.falloff; hh[1] = P.baseY; hh[2] = P.cloudDensity * cloud; hh[3] = 0;
    awayC.setRGB(
      P.awayCol[0] + (P.spaceCol[0] - P.awayCol[0]) * space,
      P.awayCol[1] + (P.spaceCol[1] - P.awayCol[1]) * space,
      P.awayCol[2] + (P.spaceCol[2] - P.awayCol[2]) * space);
    scene.fog.color.copy(awayC);
    // from orbit the ground should stay readable through the column of haze
    const dens = P.density * (1 - 0.6 * space);
    scene.fog.density = dens; skyFogDensity.value = dens;
  }
  const prevBefore = scene.onBeforeRender;
  scene.onBeforeRender = function (r, s, cam, rt) {
    if (prevBefore) prevBefore.call(this, r, s, cam, rt);
    if (!s.fog || !cam) return;
    cam.getWorldPosition(camPos);
    write(camPos.x, camPos.y, camPos.z, skyMat.uniforms.uSpace.value || 0);
  };

  // ---------------------------------------------------------------- re-bake image-based lighting
  // The engine baked scene.environment from the old sky; bake again so reflections carry the haze.
  try {
    write(0, 80, 0, 0);
    const envScene = new THREE.Scene();
    const envSky = skyMat.clone();   // typed-array uniforms stay shared; the Color is snapshotted
    envSky.uniforms.uSpace.value = 0;
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), envSky));
    const gc = new THREE.Color(0x6d6458).convertSRGBToLinear().lerp(awayC, 0.35);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(49, 32), new THREE.MeshBasicMaterial({ color: gc }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -2; envScene.add(ground);
    const pm = new THREE.PMREMGenerator(renderer);
    const old = scene.environment;
    scene.environment = pm.fromScene(envScene, 0.02, 0.1, 100).texture;
    pm.dispose(); envSky.dispose(); ground.geometry.dispose(); ground.material.dispose();
    if (old && old.dispose) old.dispose();
  } catch (e) { console.warn('atmosphere: env re-bake skipped', e); }

  window.SM_ATMOS = { params: P, uniforms: U };   // console tuning handle

  return {
    update(dt) {
      // smooth the in-cloud whiteout instead of popping it on and off
      const pl = ctx.getPlayer && ctx.getPlayer();
      const target = pl && pl.inCloud > 0 ? 1 : 0;
      cloud += (target - cloud) * (1 - Math.exp(-6 * dt));
    }
  };
});
