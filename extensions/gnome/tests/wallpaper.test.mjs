import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import {Actor} from './actors.mjs';

class ShaderEffect {
    uniforms = new Map();
    get_actor() { return this.actor; }
    get_texture() { return this.texture; }
    set_uniform_float(name, count, values) {
        assert.equal(typeof name, 'string');
        assert.equal(values.length, count);
        this.uniforms.set(name, Array.from(values));
    }
    vfunc_paint_target(node, paintContext) { this.lastPaint = {node, paintContext}; }
}

class GLSLEffect extends ShaderEffect {
    uniformNames = ['pixel_step', 'bounds', 'clip_radius'];
    get_uniform_location(name) {
        const location = this.uniformNames.indexOf(name);
        assert.ok(location >= 0);
        return location;
    }
    set_uniform_float(location, count, values) {
        assert.ok(Number.isInteger(location));
        super.set_uniform_float(this.uniformNames[location], count, values);
    }
    add_glsl_snippet(hook, declarations, code, replace) {
        assert.equal(replace, false);
        this.snippet = {hook, declarations, code};
    }
}

function allocation(width, height) {
    return {x1: 0, y1: 0, x2: width, y2: height,
        get_width: () => width, get_height: () => height};
}


function setup({shell51 = false} = {}) {
    const windows = [];
    let changes = 0;
    const monitor = {x: 1920, y: 0, width: 1920, height: 1080};
    const work = {x: 1960, y: 32, width: 1880, height: 1048};
    let monitors = [{connector: 'DP-1', geometry: {x: 0, y: 0, width: 1920, height: 1080}}];
    const source = readFileSync(new URL('../extension/wallpaper.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
    const Wallpaper = vm.runInNewContext(`${source}\n({LiveWallpaper, APPLICATION_ID, collectRenderers})`, {
        St: {Widget: Actor}, GObject: {registerClass(klass) {
            if (klass.prototype instanceof ShaderEffect) {
                const methods = Object.getOwnPropertyNames(klass.prototype);
                assert.equal(methods.includes('vfunc_build_pipeline'), !shell51);
                assert.equal(methods.includes('vfunc_get_static_snippet'), shell51);
            }
            return klass;
        }},
        Clutter: {Clone: Actor, FixedLayout: class {}, BinLayout: class {}, AnimationMode: {},
            ShaderEffect: shell51 ? ShaderEffect : class {}},
        Shell: shell51 ? {} : {GLSLEffect},
        Cogl: {SnippetHook: {FRAGMENT: 1}, Snippet: {
            new: (hook, declarations, code) => ({hook, declarations, code}),
        }},
        Main: {layoutManager: {monitors: [monitor], getWorkAreaForMonitor: () => work}},
        BlurController: class {setState() {} destroy() {}},
        PauseEffectKind: {BLUR: 'blur'},
        global: {
            backend: {get_monitor_manager: () => ({get_monitor_for_connector:
                connector => monitors.findIndex(m => m.connector === connector)})},
            display: {get_n_monitors: () => monitors.length,
                get_monitor_geometry: index => monitors[index].geometry}},
    });
    function renderer(connector = 'DP-1', geometry = monitors[0].geometry) {
        const hints = JSON.stringify({presentationReady: true, connector, geometry});
        const actor = new Actor({width: 1920, height: 1080, meta_window: {
            title: `@${Wallpaper.APPLICATION_ID}!${hints}`, get_monitor: () => 0,
        }});
        windows.push(actor);
        return {actor, launcher: {ownsWindow: window => window === actor.meta_window}};
    }
    function wallpaper(role = 'desktop') {
        const background = new Actor({monitor: 0});
        const content = new Actor({brightness: 0.5, vignette: false, rounded_clip_radius: 0});
        Object.defineProperty(background, 'content', {get() {
            assert.ok(!background.destroying && !background.disposed, 'read disposing background');
            return content;
        }});
        let removed = false;
        const actor = new Wallpaper.LiveWallpaper(background, role,
            () => { removed = true; }, () => changes++);
        const parentId = background.connect('destroy', () => actor.destroyWithBackground());
        return {actor, background, content, get removed() { return removed; },
            detachOwner() { background.disconnect(parentId); }};
    }
    return {renderer, wallpaper, get changes() { return changes; },
        sources(launcher = {ownsWindow: () => true}) {
            return Wallpaper.collectRenderers(windows.filter(w => !w.disposed), launcher);
        }, setMonitors(next) { monitors = next; }};
}

test('parent disposal releases the view and preserves default child destruction', () => {
    const s = setup();
    const r = s.renderer();
    const view = s.wallpaper();
    view.actor.syncRenderer(r.actor);
    const clone = view.actor._cloneActor;
    const extra = new Actor();
    view.actor.add_child(extra);
    view.background.destroy();
    assert.ok(view.removed);
    assert.ok(view.actor.disposed && clone.disposed && extra.disposed);
    assert.equal(r.actor.handlers.size, 0);
    view.actor.syncRenderer(r.actor);
    view.actor.setPresentation(null);
    r.actor.destroy();
});

test('explicit destruction restores the backdrop and ignores later synchronization', () => {
    const s = setup();
    const view = s.wallpaper();
    assert.equal(view.content.brightness, 0);
    const r = s.renderer();
    view.actor.destroy();
    assert.ok(view.removed);
    assert.deepEqual({brightness: view.content.brightness, vignette: view.content.vignette}, {brightness: 0.5, vignette: false});
    view.actor.syncRenderer(r.actor);
    assert.equal(r.actor.handlers.size, 0);
    view.detachOwner();
    view.background.destroy();
});

test('source replacement releases old callbacks and preserves an unchanged clone', () => {
    const s = setup();
    const old = s.renderer();
    const next = s.renderer();
    const {actor} = s.wallpaper();
    actor.syncRenderer(old.actor);
    const clone = actor._cloneActor;
    actor.syncRenderer(next.actor);
    assert.ok(clone.disposed);
    assert.equal(old.actor.handlers.size, 0);
    assert.equal(actor._cloneActor.source, next.actor);
    const healthy = actor._cloneActor;
    actor.syncRenderer(next.actor);
    assert.equal(actor._cloneActor, healthy);
    old.actor.destroy();
    assert.equal(actor._cloneActor.source, next.actor);
});

test('source and clone destruction request reconciliation and release stale bindings', () => {
    const s = setup();
    const r = s.renderer();
    const {actor} = s.wallpaper();
    actor.syncRenderer(r.actor);
    actor._cloneActor.destroy();
    assert.equal(s.changes, 1);
    assert.equal(r.actor.handlers.size, 0);
    actor.syncRenderer(r.actor);
    r.actor.destroy();
    assert.equal(s.changes, 2);
    assert.equal(actor._cloneActor, null);
});

test('overview fallback restores brightness while the desktop fallback remains black', () => {
    const s = setup();
    const r = s.renderer();
    const {actor, content} = s.wallpaper('other');
    assert.deepEqual({brightness: content.brightness, vignette: content.vignette}, {brightness: 0.5, vignette: false});
    actor.syncRenderer(r.actor);
    assert.deepEqual({brightness: content.brightness, vignette: content.vignette}, {brightness: 0, vignette: true});
    actor.syncRenderer(null);
    assert.deepEqual({brightness: content.brightness, vignette: content.vignette}, {brightness: 0.5, vignette: false});
    const desktop = s.wallpaper();
    desktop.actor.syncRenderer(null);
    assert.deepEqual({brightness: desktop.content.brightness, vignette: desktop.content.vignette}, {brightness: 0, vignette: true});
});

test('overview previews show ready frames immediately while keeping the placeholder black', () => {
    const s = setup();
    const first = s.renderer();
    const next = s.renderer();
    const view = s.wallpaper('other');
    assert.equal(view.actor.opacity, 0);
    for (const source of [first.actor, next.actor]) {
        view.actor.syncRenderer(source);
        const clone = view.actor._cloneActor;
        assert.equal(view.actor.opacity, 255);
        assert.equal(clone.opacity, 255);
        assert.equal(clone.easeCalls.length, 0, 'ready overview frames must not fade from black');
        assert.deepEqual({brightness: view.content.brightness, vignette: view.content.vignette}, {brightness: 0, vignette: true});
        view.actor.syncRenderer(null);
        assert.ok(clone.disposed);
        assert.equal(view.actor.opacity, 0);
        assert.deepEqual({brightness: view.content.brightness, vignette: view.content.vignette}, {brightness: 0.5, vignette: false});
    }
    view.background.destroy();
});

test('desktop attachment keeps its fade without restarting unchanged bindings', () => {
    const s = setup();
    const source = s.renderer();
    const view = s.wallpaper();
    view.actor.syncRenderer(source.actor);
    const clone = view.actor._cloneActor;
    assert.equal(clone.easeCalls.length, 1);
    assert.equal(clone.easeCalls[0].from, 0);
    assert.equal(clone.easeCalls[0].opacity, 255);
    assert.equal(clone.easeCalls[0].duration, 800);
    view.actor.syncRenderer(source.actor);
    assert.equal(view.actor._cloneActor, clone);
    assert.equal(clone.easeCalls.length, 1);
    view.background.destroy();
});

test('output identity excludes a migrated disconnected source', () => {
    const s = setup();
    s.renderer('DP-2', {x: 1920, y: 0, width: 1920, height: 1080});
    const primary = s.renderer('DP-1');
    assert.equal(s.sources().size, 1);
    assert.equal(s.sources().get(0), primary.actor);
    s.setMonitors([]);
    assert.equal(s.sources().size, 0);
});

test('outputs become ready independently and zero-sized sources are excluded', () => {
    const s = setup();
    const geometry = {x: 1920, y: 0, width: 1920, height: 1080};
    s.setMonitors([{connector: 'DP-1', geometry: {x: 0, y: 0, width: 1920, height: 1080}},
        {connector: 'DP-2', geometry}]);
    const primary = s.renderer('DP-1');
    const secondary = s.renderer('DP-2', geometry);
    secondary.actor.width = 0;
    assert.equal(s.sources().get(0), primary.actor);
    assert.equal(s.sources().has(1), false);
    secondary.actor.width = 1920;
    assert.equal(s.sources().get(1), secondary.actor);
});

test('geometry fallback, ownership and ambiguity do not depend on enumeration order', () => {
    const s = setup();
    const primary = s.renderer(null);
    s.renderer(null, {x: 1920, y: 0, width: 1920, height: 1080});
    assert.equal(s.sources(primary.launcher).get(0), primary.actor);
    const next = s.renderer(null);
    assert.equal(s.sources(next.launcher).get(0), next.actor);
    s.renderer(null);
    assert.equal(s.sources().has(0), false, 'three candidates must remain ambiguous');
    assert.equal(s.sources(null).size, 0);
});

test('overview clip follows work area, preview size and animated radius', () => {
    const s = setup();
    const r = s.renderer();
    const {actor, background, content} = s.wallpaper('other');
    actor.syncRenderer(r.actor);
    actor.vfunc_allocate(allocation(1920, 1080));
    assert.equal(actor.effects.size, 0);

    content.rounded_clip_radius = 30;
    content.emit('notify::rounded-clip-radius');
    assert.equal(actor.relayouts, 1);
    actor.vfunc_allocate(allocation(960, 540));
    const effect = actor._clipEffect;
    assert.ok(actor.effects.has(effect));
    assert.deepEqual(Array.from(effect._bounds), [20, 16, 960, 540]);
    assert.equal(effect._radius, 15);
    assert.equal(actor._cloneActor.scale_x, 0.5);
    assert.equal(actor._cloneActor.scale_y, 0.5);

    actor.vfunc_allocate(allocation(480, 270));
    assert.equal(actor._clipEffect, effect);
    assert.deepEqual(Array.from(effect._bounds), [10, 8, 480, 270]);
    assert.equal(effect._radius, 7.5);

    content.rounded_clip_radius = 0;
    content.emit('notify::rounded-clip-radius');
    actor.vfunc_allocate(allocation(1920, 1080));
    assert.equal(actor._clipEffect, null);
    assert.equal(actor.effects.size, 0);
    background.destroy();
    assert.equal(content.handlers.size, 0);
});

test('clip uniforms account for offscreen offset and HiDPI changes', () => {
    const s = setup();
    const r = s.renderer();
    const {actor, background, content} = s.wallpaper('other');
    actor.syncRenderer(r.actor);
    content.rounded_clip_radius = 30;
    actor.vfunc_allocate(allocation(960, 540));
    const effect = actor._clipEffect;
    effect.texture = {get_width: () => 964, get_height: () => 544};
    effect._uploadUniforms();
    assert.deepEqual(effect.uniforms.get('bounds'), [22, 18, 962, 542]);
    assert.deepEqual(effect.uniforms.get('clip_radius'), [15]);
    assert.deepEqual(effect.uniforms.get('pixel_step'), [1 / 964, 1 / 544]);

    actor.resourceScale = 2;
    effect.texture = {get_width: () => 1928, get_height: () => 1088};
    effect._uploadUniforms();
    assert.deepEqual(effect.uniforms.get('bounds'), [44, 36, 1924, 1084]);
    assert.deepEqual(effect.uniforms.get('clip_radius'), [30]);
    assert.deepEqual(effect.uniforms.get('pixel_step'), [1 / 1928, 1 / 1088]);

    actor.paintVolume = {get_origin: () => ({x: -10, y: -6}),
        get_width: () => 980, get_height: () => 552};
    effect._uploadUniforms();
    assert.deepEqual(effect.uniforms.get('bounds'), [64, 48, 1944, 1096]);
    background.destroy();
    assert.equal(actor._clipEffect, null);
    assert.equal(actor.effects.size, 0);
    assert.equal(content.handlers.size, 0);
});

for (const shell51 of [false, true]) {
    test(`rounded clip shader renders and resizes with ${shell51 ? 'GNOME 51' : 'legacy GLSLEffect'}`, () => {
        const s = setup({shell51});
        const r = s.renderer();
        const {actor, background, content} = s.wallpaper('other');
        actor.syncRenderer(r.actor);
        content.rounded_clip_radius = 30;
        actor.vfunc_allocate(allocation(960, 540));
        const effect = actor._clipEffect;
        let snippet;
        if (shell51) {
            snippet = effect.vfunc_get_static_snippet();
        } else {
            effect.vfunc_build_pipeline();
            snippet = effect.snippet;
        }
        assert.equal(snippet.hook, 1);
        assert.match(snippet.declarations, /uniform vec4 bounds;/);
        assert.match(snippet.code, /cogl_color_out \*= rounded_rect_coverage/);

        const node = {}, paintContext = {};
        effect.texture = {get_width: () => 964, get_height: () => 544};
        effect.vfunc_paint_target(node, paintContext);
        assert.deepEqual(effect.lastPaint, {node, paintContext});
        assert.deepEqual(effect.uniforms.get('bounds'), [22, 18, 962, 542]);
        assert.deepEqual(effect.uniforms.get('clip_radius'), [15]);
        assert.deepEqual(effect.uniforms.get('pixel_step'), [1 / 964, 1 / 544]);

        content.rounded_clip_radius = 40;
        content.emit('notify::rounded-clip-radius');
        actor.vfunc_allocate(allocation(480, 270));
        actor.resourceScale = 2;
        effect.texture = {get_width: () => 968, get_height: () => 548};
        effect.vfunc_paint_target(node, paintContext);
        assert.equal(actor._clipEffect, effect);
        assert.deepEqual(effect.uniforms.get('bounds'), [24, 20, 964, 544]);
        assert.deepEqual(effect.uniforms.get('clip_radius'), [20]);
        assert.deepEqual(effect.uniforms.get('pixel_step'), [1 / 968, 1 / 548]);

        background.destroy();
        assert.equal(actor.effects.size, 0);
        assert.equal(content.handlers.size, 0);
    });
}

