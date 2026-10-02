/*
 * Screen-space ambient occlusion (SAO-style, two radii) for Superman Over Metropolis.
 *
 * Contact shadow is what makes the Spider-Man and Arkham cities read as solid: walls darken where
 * they meet the pavement, window reveals and cornices get depth, and cars sit on the road. The
 * engine has no AO, so this adds it as a composer pass:
 *
 *   1. normal+depth prepass at half resolution (scene.overrideMaterial writes view normal and
 *      linear depth to a float target; transparent things hidden)
 *   2. AO at half resolution: 12 samples per pixel, half at ~1.2 m (contact) and half at
 *      ~6 m (street-canyon and wall-base occlusion), normals rebuilt from depth
 *   3. composite at full resolution: depth-aware 4x4 upsample-blur, multiplied into the HDR
 *      colour before bloom and grading, and faded out with distance and in sky pixels
 *
 * Enabled on Ultra and the screenshot preset (it roughly doubles draw calls). Force it with
 * ?ao=1 or turn it off with ?ao=0. Debug hook: window.__ao = { enable, strength, view }.
 */
(function () {
  window.SM_PLUGINS = window.SM_PLUGINS || [];
  window.SM_PLUGINS.push(function ao(ctx) {
    const { THREE, renderer, scene, camera, composer, quality, sky } = ctx;
    const q = location.search;
    const want = /[?&]ao=1/.test(q) || ((quality === 'ultra' || quality === 'shot') && !/[?&]ao=0/.test(q));
    if (!want || !renderer.capabilities.isWebGL2 || !THREE.DepthTexture) return {};

    const S = { enable: true, strength: 1.0, view: false };

    // prepass target: view-space normal in rgb, linear view depth (metres) in alpha; 0 depth = sky
    const ext = renderer.extensions.get('EXT_color_buffer_float');
    const depthRT = new THREE.WebGLRenderTarget(4, 4, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, format: THREE.RGBAFormat, type: ext ? THREE.FloatType : THREE.HalfFloatType });
    depthRT.depthBuffer = true;
    const aoRT = new THREE.WebGLRenderTarget(4, 4, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat });
    // instancing-aware normal+depth material (the chunks apply instanceMatrix when USE_INSTANCING is set)
    const depthMat = new THREE.ShaderMaterial({
      vertexShader: `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vN; varying float vW;
        void main() {
          #include <beginnormal_vertex>
          #include <defaultnormal_vertex>
          #include <begin_vertex>
          #include <project_vertex>
          #include <logdepthbuf_vertex>
          vN = normalize(transformedNormal); vW = -mvPosition.z;
        }`,
      fragmentShader: `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying vec3 vN; varying float vW;
        void main() {
          #include <logdepthbuf_fragment>
          vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
          gl_FragColor = vec4(n, vW);
        }`,
      side: THREE.DoubleSide
    });

    const aoMat = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: depthRT.texture }, uRes: { value: new THREE.Vector2(1, 1) },
        uP: { value: new THREE.Vector2(1, 1) }, uDbg: { value: 0 }
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        precision highp float;
        uniform sampler2D tDepth; uniform vec2 uRes, uP; uniform float uDbg;
        varying vec2 vUv;
        vec3 viewPos(vec2 uv, float w) { return vec3((uv * 2.0 - 1.0) * w / uP, -w); }
        void main() {
          vec4 g = texture2D(tDepth, vUv);
          float w = g.a;
          if (w <= 0.0) { gl_FragColor = vec4(1.0); return; }
          vec3 p = viewPos(vUv, w), n = g.rgb;
          // 4x4 interleaved rotations: the composite's 3x3 blur averages them into smooth shading
          vec2 ip = mod(floor(gl_FragCoord.xy), 4.0);
          float ang = (ip.x * 4.0 + ip.y + fract(ip.x * 0.37 + ip.y * 0.61)) * (6.2831853 / 16.0);
          float occ = 0.0, tot = 0.0;
          for (int i = 0; i < 12; i++) {
            float fi = float(i);
            bool big = i >= 6;
            float R = big ? 6.0 : 1.2;
            float t = (mod(fi, 6.0) + 0.5) / 6.0;
            float a = ang + fi * 2.39996;
            // screen-space offset for a world radius R at this depth, capped so far pixels stay cheap
            vec2 off = vec2(cos(a), sin(a)) * t * R * uP / w * 0.5;
            off *= min(1.0, 0.12 / max(length(off), 1e-5));
            vec2 suv = vUv + off;
            if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
            float sw = texture2D(tDepth, suv).a;
            tot += 1.0;
            if (sw <= 0.0) continue;
            vec3 s = viewPos(suv, sw) - p;
            float l2 = dot(s, s), l = sqrt(l2);
            float fall = max(0.0, 1.0 - l2 / (R * R));
            occ += fall * max(0.0, dot(n, s) / (l + 1e-4) - 0.1) * (big ? 0.9 : 1.2);
          }
          float ao = 1.0 - occ / max(tot, 1.0) * 3.8;
          if (uDbg > 2.5) { float v = occ / max(tot, 1.0); gl_FragColor = vec4(v, v != v ? 1.0 : 0.0, tot / 12.0, 1.0); return; }
          if (uDbg > 0.5) { gl_FragColor = uDbg > 1.5 ? vec4(vec3(fract(w / 10.0)), 1.0) : vec4(n * 0.5 + 0.5, 1.0); return; }
          gl_FragColor = vec4(clamp(ao, 0.0, 1.0), 1.0, 1.0, 1.0);
        }`,
      depthTest: false, depthWrite: false
    });

    const compMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tAO: { value: aoRT.texture }, tDepth: { value: depthRT.texture },
        uAORes: { value: new THREE.Vector2(1, 1) }, uStrength: { value: 1 }, uView: { value: 0 }
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        precision highp float;
        uniform sampler2D tDiffuse, tAO, tDepth; uniform vec2 uAORes; uniform float uStrength, uView;
        varying vec2 vUv;
        void main() {
          vec4 col = texture2D(tDiffuse, vUv);
          float w0 = texture2D(tDepth, vUv).a;
          // depth-aware 4x4 blur of the half-res AO
          float sum = 0.0, wsum = 0.0;
          for (int y = -2; y <= 1; y++) for (int x = -2; x <= 1; x++) {
            vec2 uv = vUv + (vec2(float(x), float(y)) + 0.5) / uAORes;
            float wd = texture2D(tDepth, uv).a;
            float wt = 1.0 / (1.0 + abs(wd - w0) / (0.02 * w0 + 0.05) * 8.0);
            sum += texture2D(tAO, uv).x * wt; wsum += wt;
          }
          float ao = sum / max(wsum, 1e-4);
          // fade with distance: half-res depth is too coarse for far towers, and haze hides it anyway
          float fade = w0 <= 0.0 ? 0.0 : 1.0 - smoothstep(180.0, 650.0, w0);
          ao = mix(1.0, pow(clamp(ao, 0.0, 1.0), 1.4), fade * uStrength);
          gl_FragColor = uView > 1.5 ? vec4(texture2D(tAO, vUv).rgb, 1.0) : uView > 0.5 ? vec4(vec3(ao), 1.0) : vec4(col.rgb * ao, col.a);
        }`,
      depthTest: false, depthWrite: false
    });

    // things that must not write depth in the prepass: particles, glows, beams, water spray
    // three r128 reuses the override program across instanced meshes with and without instanceColor,
    // so colours are detached for the depth-only prepass (they don't matter there)
    let hidden = [], tinted = [], hideT = 0;
    function collectHidden() {
      hidden = []; tinted = [];
      scene.traverse(o => {
        if (o.isInstancedMesh && o.instanceColor) tinted.push(o);
        const m = o.material;
        if (!m || o === scene) return;
        const ms = Array.isArray(m) ? m : [m];
        if (o === sky || o.isPoints || o.isSprite || o.isLine || ms.some(x => x.transparent || x.depthWrite === false || x.blending === THREE.AdditiveBlending)) hidden.push(o);
      });
    }

    class AOPass extends THREE.Pass {
      constructor() { super(); this.needsSwap = true; this.quad = new THREE.FullScreenQuad(null); }
      setSize(w, h) {
        const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
        depthRT.setSize(hw, hh); aoRT.setSize(hw, hh);
        aoMat.uniforms.uRes.value.set(hw, hh); compMat.uniforms.uAORes.value.set(hw, hh);
      }
      render(r, writeBuffer, readBuffer) {
        if (!S.enable) { // pass through
          compMat.uniforms.uStrength.value = 0;
        } else {
          const now = performance.now();
          if (now - hideT > 1000) { collectHidden(); hideT = now; }
          aoMat.uniforms.uP.value.set(camera.projectionMatrix.elements[0], camera.projectionMatrix.elements[5]);
          aoMat.uniforms.uDbg.value = S.dbg || 0;
          // 1. depth prepass
          const vis = hidden.map(o => o.visible), cols = tinted.map(o => o.instanceColor);
          for (const o of hidden) o.visible = false;
          for (const o of tinted) o.instanceColor = null;
          const ov = scene.overrideMaterial, bg = scene.background, sm = r.shadowMap.autoUpdate;
          scene.overrideMaterial = depthMat; r.shadowMap.autoUpdate = false;
          const cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
          r.setClearColor(0x000000, 0); r.setRenderTarget(depthRT); r.clear(true, true, false); r.render(scene, camera); r.setClearColor(cc, ca);
          scene.overrideMaterial = ov; scene.background = bg; r.shadowMap.autoUpdate = sm;
          hidden.forEach((o, i) => { o.visible = vis[i]; });
          tinted.forEach((o, i) => { o.instanceColor = cols[i]; });
          // 2. AO
          this.quad.material = aoMat; r.setRenderTarget(aoRT); this.quad.render(r);
          compMat.uniforms.uStrength.value = S.strength;
        }
        // 3. composite
        compMat.uniforms.uView.value = S.dbg ? 2 : S.view ? 1 : 0; aoMat.uniforms.uDbg.value = S.dbg || 0;
        compMat.uniforms.tDiffuse.value = readBuffer.texture;
        this.quad.material = compMat;
        r.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        this.quad.render(r);
      }
    }

    const pass = new AOPass();
    const passes = composer.passes;
    const ri = passes.findIndex(p => p instanceof THREE.RenderPass);
    composer.insertPass(pass, ri + 1);
    window.__ao = S; S.aoRT = aoRT; S.depthRT = depthRT;
    return {};
  });
})();
