// Experimental: "bake" the converged path-traced frame onto the product's uv1
// texture (a screen→UV projection bake, single camera view), then display it as
// a flat raster map. Lets us A/B the live path tracer vs. a frozen baked look.
//
// v1 limitation: only surfaces visible from the CURRENT camera get baked —
// orbit away and the un-seen areas are holes. A full bake = repeat from several
// angles to fill each atlas. This is enough to measure the "pop" on PT→raster.
//
// FIDDLY BITS (likely to need a tweak once seen on a real GPU): the canvas Y
// orientation (CANVAS_FLIP_Y) and colour management. Both are flagged below.

import * as THREE from "three";

const CANVAS_FLIP_Y = false; // WebGL canvas is bottom-up like clip space; flip if upside-down

const VERT = /* glsl */`
  attribute vec2 uv1;          // second UV set (TEXCOORD_1) the lightmap lives on
  varying vec3 vWorld;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    // lay the mesh out flat in its lightmap UV space
    gl_Position = vec4(uv1 * 2.0 - 1.0, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uPT;       // captured path-traced frame
  uniform mat4 uCamProj;
  uniform mat4 uCamView;
  varying vec3 vWorld;
  void main() {
    // where did this surface point appear on screen in the PT frame?
    vec4 clip = uCamProj * uCamView * vec4(vWorld, 1.0);
    vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
    if (clip.w <= 0.0 || suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); // off-screen / behind camera → hole
      return;
    }
    gl_FragColor = vec4(texture2D(uPT, suv).rgb, 1.0);
  }
`;

// Returns a restore() that puts the original materials back.
export function bakeFromPathTracer({ renderer, chair, camera, size = 1024 }) {
  // 1) capture the converged PT frame off the canvas (preserveDrawingBuffer is on)
  const ptTex = new THREE.CanvasTexture(renderer.domElement);
  ptTex.flipY = CANVAS_FLIP_Y;
  ptTex.colorSpace = THREE.SRGBColorSpace;
  ptTex.needsUpdate = true;

  const bakeMat = new THREE.ShaderMaterial({
    uniforms: {
      uPT: { value: ptTex },
      uCamProj: { value: camera.projectionMatrix },
      uCamView: { value: camera.matrixWorldInverse },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });

  const bakeScene = new THREE.Scene();
  bakeScene.matrixWorldAutoUpdate = false;
  const dummyCam = new THREE.Camera(); // unused by the shader, but render() needs one

  chair.updateMatrixWorld(true);
  const meshes = [];
  chair.traverse((n) => { if (n.isMesh && n.geometry.attributes.uv1) meshes.push(n); });

  const restores = [];
  const prevTarget = renderer.getRenderTarget();
  const prevClear = new THREE.Color();
  renderer.getClearColor(prevClear);
  const prevAlpha = renderer.getClearAlpha();

  for (const mesh of meshes) {
    const rt = new THREE.WebGLRenderTarget(size, size, { colorSpace: THREE.SRGBColorSpace });
    const temp = new THREE.Mesh(mesh.geometry, bakeMat);
    temp.matrixAutoUpdate = false;
    temp.matrixWorldAutoUpdate = false;
    temp.matrixWorld.copy(mesh.matrixWorld);
    bakeScene.add(temp);

    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(bakeScene, dummyCam);
    bakeScene.remove(temp);

    const baked = rt.texture;
    baked.channel = 1; // displayed via uv1
    restores.push({ mesh, orig: mesh.material });
    const m = new THREE.MeshBasicMaterial({ map: baked });
    m.map.channel = 1;
    mesh.material = m;
  }

  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);

  return function restore() {
    for (const { mesh, orig } of restores) mesh.material = orig;
  };
}
