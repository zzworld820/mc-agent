import * as THREE from 'three';
import { io } from 'socket.io-client';
import { Vec3 } from 'vec3';
import viewerModule from 'prismarine-viewer/viewer/lib/viewer.js';

const { Viewer } = viewerModule;
// Upstream's entity model module expects the same global THREE instance.
globalThis.THREE = THREE;

export function columnBounds(json) {
  const column = typeof json === 'string' ? JSON.parse(json) : json;
  const minY = column.minY ?? -64;
  return { minY, maxY: minY + (column.worldHeight ?? column.sections.length * 16) };
}

/** Thin instance adaptation of WorldRenderer 1.33; no patched vendor bundle. */
export function adaptWorldRenderer(world) {
  const bounds = new Map();
  const reset = world.resetWorld.bind(world);
  let generation = 0;
  world.resetWorld = () => {
    generation++;
    for (const mesh of Object.values(world.sectionMeshs)) mesh.geometry.dispose();
    reset();
    bounds.clear();
    world.loadedChunks = {};
    world.sectionsOutstanding.clear();
    world.renderUpdateEmitter.emit('update');
    for (const worker of world.workers) worker.postMessage({ type: 'reset', generation });
  };
  for (const worker of world.workers) {
    const onmessage = worker.onmessage;
    worker.onmessage = event => {
      if (event.data.generation !== generation) return;
      if (event.data.type === 'error') world.onError?.(event.data.error);
      else onmessage(event);
    };
    worker.onerror = error => world.onError?.(error.message || 'Mesh worker 加载失败');
  }
  const dirty = world.setSectionDirty.bind(world);
  world.setSectionDirty = (pos, value = true) => {
    const x = Math.floor(pos.x / 16) * 16;
    const y = Math.floor(pos.y / 16) * 16;
    const z = Math.floor(pos.z / 16) * 16;
    const range = bounds.get(`${x},${z}`);
    if (!range || y < range.minY || y >= range.maxY) return;
    dirty(pos, value);
  };
  world.addColumn = (x, z, chunk) => {
    const range = columnBounds(chunk);
    bounds.set(`${x},${z}`, range);
    world.loadedChunks[`${x},${z}`] = true;
    for (const worker of world.workers) worker.postMessage({ type: 'chunk', x, z, chunk });
    for (let y = range.minY; y < range.maxY; y += 16) {
      for (const [dx, dz] of [[0, 0], [-16, 0], [16, 0], [0, -16], [0, 16]]) world.setSectionDirty(new Vec3(x + dx, y, z + dz));
    }
  };
  world.removeColumn = (x, z) => {
    const range = bounds.get(`${x},${z}`);
    if (!range) return;
    delete world.loadedChunks[`${x},${z}`];
    for (const worker of world.workers) worker.postMessage({ type: 'unloadChunk', x, z });
    for (let y = range.minY; y < range.maxY; y += 16) {
      const key = `${x},${y},${z}`;
      const mesh = world.sectionMeshs[key];
      if (mesh) { world.scene.remove(mesh); mesh.geometry.dispose(); delete world.sectionMeshs[key]; }
      world.sectionsOutstanding.delete(key);
      for (const [dx, dz] of [[-16, 0], [16, 0], [0, -16], [0, 16]]) world.setSectionDirty(new Vec3(x + dx, y, z + dz));
    }
    bounds.delete(`${x},${z}`);
    world.renderUpdateEmitter.emit('update');
  };
  // Do not call Viewer.setVersion: its getVersion silently turns 1.21.6 into
  // 1.21.4. stateIds must ALWAYS be decoded with the real server version.
  world.configure = ({ version, assetVersion }) => {
    world.resetWorld();
    world.version = version;
    world.active = true;
    for (const worker of world.workers) worker.postMessage({ type: 'version', version, generation });
    const current = generation;
    if (!world.modelsPromise) {
      world.modelsPromise = fetch(`blocksStates/${assetVersion}.json`).then(response => {
        if (!response.ok) throw new Error(`模型素材 HTTP ${response.status}`);
        return response.json();
      });
      new THREE.TextureLoader().load(`textures/${assetVersion}.png`, texture => {
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.flipY = false;
        world.material.map = texture;
        world.material.needsUpdate = true;
      }, undefined, () => world.onError?.('纹理素材加载失败'));
    }
    world.modelsPromise.then(json => {
      if (current !== generation) return;
      for (const worker of world.workers) worker.postMessage({ type: 'blockStates', json });
    }).catch(error => world.onError?.(error.message));
  };
  return world;
}

export function applyCamera(camera, mode, pose) {
  const { pos, yaw = 0, pitch = 0, height = 1.8 } = pose;
  const eye = new THREE.Vector3(pos.x, pos.y + height * 0.9, pos.z);
  camera.up.set(0, 1, 0);
  if (mode === 'first') {
    camera.position.copy(eye);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
  } else if (mode === 'top') {
    camera.position.set(pos.x, pos.y + 48, pos.z);
    camera.up.set(0, 0, -1);
    camera.lookAt(pos.x, pos.y, pos.z);
  } else {
    camera.position.set(pos.x + Math.sin(yaw) * 7, pos.y + 4, pos.z + Math.cos(yaw) * 7);
    camera.lookAt(eye);
  }
  camera.updateMatrixWorld();
}

function point(value) {
  const p = value?.position || value?.pos || value;
  return p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k])) ? new THREE.Vector3(p.x, p.y, p.z) : null;
}

// Boxes accept {min,max}, {start,end}, {origin,size:{width,depth,wallHeight}},
// or {x,y,z,radius}; room dimensions are inclusive block bounds.
export function boxBounds(value, defaultRadius = 4) {
  if (!value) return null;
  const min = point(value.min || value.start || value.bounds?.min);
  const max = point(value.max || value.end || value.bounds?.max);
  if (min && max) return { min, max };
  const origin = point(value.origin);
  if (origin && value.size) return { min: origin, max: origin.clone().add(new THREE.Vector3(
    value.size.width || 1, (value.size.wallHeight || value.size.height || 3) + 1, value.size.depth || 1)) };
  const center = point(value.center || value);
  if (!center) return null;
  const radius = Number.isFinite(value.radius) ? value.radius : defaultRadius;
  return { min: center.clone().add(new THREE.Vector3(-radius, -1, -radius)),
    max: center.clone().add(new THREE.Vector3(radius + 1, 4, radius + 1)) };
}

function dispose(group) {
  group.traverse(object => {
    object.geometry?.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material?.dispose();
  });
  group.clear();
}

export function drawDebug(group, debug) {
  dispose(group);
  const material = color => new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85 });
  const line = (values, color) => {
    const points = (Array.isArray(values) ? values : values?.points || values?.path || []).map(point).filter(Boolean);
    if (points.length < 2) return;
    for (const p of points) p.y += 0.12;
    const mesh = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material(color));
    mesh.renderOrder = 20;
    group.add(mesh);
  };
  const box = (value, color, radius) => {
    const bounds = boxBounds(value, radius);
    if (!bounds) return;
    const size = bounds.max.clone().sub(bounds.min);
    const cube = new THREE.BoxGeometry(Math.max(size.x, 0.05), Math.max(size.y, 0.05), Math.max(size.z, 0.05));
    const mesh = new THREE.LineSegments(new THREE.EdgesGeometry(cube), material(color));
    cube.dispose();
    mesh.position.copy(bounds.min).addScaledVector(size, 0.5);
    mesh.renderOrder = 20;
    group.add(mesh);
  };
  line(debug.trail, 0x54ddff);
  line(debug.path, 0xffd34f);
  if (point(debug.goal)) box({ min: point(debug.goal), max: point(debug.goal).addScalar(1) }, 0xff6633);
  box(debug.home, 0x66ff88, 4);
  const values = value => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
  for (const room of values(debug.rooms).flat()) box(room, 0xb98aff, 1);
  for (const danger of values(debug.danger)) box(danger, 0xff4055, 0.5);
  for (const protection of values(debug.protectionBoxes)) box(protection, 0x64ffae, 1);
}

export function startViewer() {
  const statusElement = document.getElementById('status');
  const notify = payload => { if (window.parent !== window) window.parent.postMessage(payload, window.location.origin); };
  const setStatus = (message, extra = {}) => {
    statusElement.textContent = message;
    notify({ type: 'viewer-status', message, ...extra });
  };
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
  catch (error) { setStatus(`WebGL 无法启动：${error.message}`, { available: false, error: error.message }); return; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.prepend(renderer.domElement);
  const viewer = new Viewer(renderer);
  adaptWorldRenderer(viewer.world);
  const overlays = new THREE.Group();
  viewer.scene.add(overlays);
  const bodyGeometry = new THREE.BoxGeometry(0.6, 1.8, 0.6);
  bodyGeometry.translate(0, 0.9, 0);
  const body = new THREE.LineSegments(new THREE.EdgesGeometry(bodyGeometry), new THREE.LineBasicMaterial({ color: 0x48eaff, depthTest: false }));
  bodyGeometry.dispose();
  body.renderOrder = 25;
  viewer.scene.add(body);
  const selected = new THREE.BoxHelper(new THREE.Mesh(new THREE.BoxGeometry(1.005, 1.005, 1.005)), 0xffffff);
  selected.visible = false;
  viewer.scene.add(selected);
  let mode = 'third';
  let pose = null;
  let running = true;
  let connectedWorld = false;
  let errorState = false;
  const config = JSON.parse(document.getElementById('viewer-config').textContent);
  const socket = io({ path: config.socketPath, transports: ['websocket', 'polling'] });
  const showError = message => { errorState = true; setStatus(message, { available: false, error: message }); };
  viewer.world.onError = showError;
  const switchCamera = next => {
    if (!['first', 'third', 'top'].includes(next)) return;
    mode = next;
    for (const button of document.querySelectorAll('[data-camera]')) button.setAttribute('aria-pressed', String(button.dataset.camera === mode));
    body.visible = mode !== 'first';
    if (pose) applyCamera(viewer.camera, mode, pose);
    notify({ type: 'viewer-status', available: connectedWorld && !errorState, mode });
  };
  const cameraMessage = event => {
    if (event.source === window.parent && event.origin === window.location.origin && event.data?.type === 'camera') switchCamera(event.data.mode);
  };
  window.addEventListener('message', cameraMessage);
  for (const button of document.querySelectorAll('[data-camera]')) button.addEventListener('click', () => switchCamera(button.dataset.camera));
  const reset = () => {
    viewer.resetAll();
    dispose(overlays);
    pose = null;
    connectedWorld = false;
    selected.visible = false;
    body.visible = false;
  };
  socket.on('world', info => {
    reset();
    errorState = false;
    viewer.version = info.version;
    viewer.world.configure(info);
    connectedWorld = true;
    setStatus(`真实世界 ${info.version} · 素材 ${info.assetVersion}`, { available: true, version: info.version, assetVersion: info.assetVersion, mode });
  });
  socket.on('reset', reset);
  socket.on('viewerStatus', state => {
    if (state.error) setStatus(state.error, state);
    else notify({ type: 'viewer-status', ...state, mode });
  });
  socket.on('loadChunk', ({ x, z, chunk }) => { try { viewer.addColumn(x, z, chunk); } catch (error) { showError(error.message); } });
  socket.on('unloadChunk', ({ x, z }) => viewer.removeColumn(x, z));
  socket.on('blockUpdate', ({ pos, stateId }) => viewer.setBlockStateId(new Vec3(pos.x, pos.y, pos.z), stateId));
  socket.on('entity', entity => {
    if (entity.delete && !viewer.entities.entities[entity.id]) return;
    // Initial metadata is required before a model can be created.
    if (!entity.name && !viewer.entities.entities[entity.id]) return;
    viewer.updateEntity(entity);
  });
  socket.on('position', next => {
    pose = next;
    body.visible = mode !== 'first';
    body.position.set(next.pos.x, next.pos.y, next.pos.z);
    body.rotation.y = next.yaw || 0;
    body.scale.set((next.width || 0.6) / 0.6, (next.height || 1.8) / 1.8, (next.width || 0.6) / 0.6);
  });
  socket.on('debug', debug => drawDebug(overlays, debug));
  socket.on('block-info', info => {
    notify({ type: 'block-info', ...info });
    if (info.position) {
      const { x, y, z } = info.position;
      selected.object.position.set(x + 0.5, y + 0.5, z + 0.5);
      selected.update();
      selected.visible = true;
      statusElement.textContent = `${info.name} (${x}, ${y}, ${z}) · ${(info.reasons || []).join('；') || '无额外保护规则'}`;
    }
  });
  socket.on('disconnect', () => { reset(); setStatus('Viewer 连接断开，等待重连…', { available: false }); });
  socket.on('connect_error', error => showError(`Viewer 连接失败：${error.message}`));
  renderer.domElement.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !connectedWorld) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const cursor = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(cursor, viewer.camera);
    socket.emit('mouseClick', { origin: raycaster.ray.origin, direction: raycaster.ray.direction, button: 0 });
  });
  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    viewer.camera.aspect = window.innerWidth / window.innerHeight;
    viewer.camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  let animation;
  function frame() {
    if (!running) return;
    viewer.update();
    if (pose) applyCamera(viewer.camera, mode, pose);
    renderer.render(viewer.scene, viewer.camera);
    animation = requestAnimationFrame(frame);
  }
  frame();
  window.addEventListener('pagehide', () => {
    running = false;
    cancelAnimationFrame(animation);
    socket.disconnect();
    for (const worker of viewer.world.workers) worker.terminate();
    viewer.resetAll();
    dispose(viewer.scene);
    viewer.world.material.map?.dispose();
    renderer.dispose();
    window.removeEventListener('message', cameraMessage);
    window.removeEventListener('resize', resize);
  }, { once: true });
}

if (typeof document !== 'undefined' && document.getElementById('viewer-config')) startViewer();
