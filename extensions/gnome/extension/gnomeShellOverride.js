import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WorkspaceThumbnail from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

import * as Wallpaper from './wallpaper.js';
import {BlurController} from './blur.js';
import {PauseEffectKind} from './controlCodec.js';

const APPLICATION_ID = Wallpaper.APPLICATION_ID;

export class GnomeShellOverride {
    constructor(settings) {
        this._injection = new InjectionManager();
        this._settings = settings;
        this._backgrounds = new Map(); // Background actor -> owned component and signals.
        this._sources = new Map();
        this._syncId = 0;
        this._enabled = false;
        this._desktopPresentation = new Map();
        this._rendererAvailable = false;
        this._rendererLauncher = null;
    }

    enable() {
        this._enabled = true;
        const self = this;

        this._injection.overrideMethod(
            Background.BackgroundManager.prototype,
            '_createBackgroundActor',
            originalMethod => function () {
                const backgroundActor = originalMethod.call(this);
                const role = this._container === Main.layoutManager._backgroundGroup
                    ? Wallpaper.WallpaperRole.Desktop
                    : Wallpaper.WallpaperRole.Other;
                self._ensureWallpaper(backgroundActor, role);
                self._queueSync();
                return backgroundActor;
            });

        // Hide the renderer windows from various enumerations. Keep them
        // matched by window title so we don't accidentally hide a real
        // user-launched program.
        const isRenderer = w => w?.title?.includes(APPLICATION_ID);

        this._injection.overrideMethod(
            Shell.Global.prototype, 'get_window_actors',
            originalMethod => function (hideRenderer = true) {
                const list = originalMethod.call(this);
                return hideRenderer
                    ? list.filter(a => !isRenderer(a.meta_window))
                    : list;
            });

        this._injection.overrideMethod(
            Workspace.Workspace.prototype, '_isOverviewWindow',
            originalMethod => function (window) {
                return isRenderer(window)
                    ? false
                    : originalMethod.apply(this, [window]);
            });

        this._injection.overrideMethod(
            WorkspaceThumbnail.WorkspaceThumbnail.prototype, '_isOverviewWindow',
            originalMethod => function (window) {
                return isRenderer(window)
                    ? false
                    : originalMethod.apply(this, [window]);
            });

        this._injection.overrideMethod(
            Meta.Display.prototype, 'get_tab_list',
            originalMethod => function (type, workspace) {
                const ws = originalMethod.apply(this, [type, workspace]);
                return ws.filter(w => !isRenderer(w));
            });

        this._injection.overrideMethod(
            Shell.WindowTracker.prototype, 'get_window_app',
            originalMethod => function (window) {
                return isRenderer(window)
                    ? null
                    : originalMethod.apply(this, [window]);
            });

        this._injection.overrideMethod(
            Shell.App.prototype, 'get_windows',
            originalMethod => function () {
                return originalMethod.call(this).filter(w => !isRenderer(w));
            });

        this._injection.overrideMethod(
            Shell.App.prototype, 'get_n_windows',
            _ => function () {
                return this.get_windows().length;
            });

        this._injection.overrideMethod(
            Shell.AppSystem.prototype, 'get_running',
            originalMethod => function () {
                return originalMethod.call(this).filter(a => a.get_n_windows() > 0);
            });

        this._readOverviewPrefs();
        this._overviewSettingsIds = [];
        if (this._settings) {
            for (const key of [
                'overview-wallpaper',
                'overview-blur',
                'overview-blur-strength',
            ]) {
                this._overviewSettingsIds.push(
                    this._settings.connect(`changed::${key}`,
                        () => this._onOverviewPrefsChanged()));
            }
        }

        this._setupOverviewBackdrop();
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed',
            () => this._queueSync());
        this._mapId = global.window_manager.connect_after('map', () => this._queueSync());
        this._queueSync();

        if (!Main.sessionMode.isLocked)
            this._reloadBackgrounds();
    }

    _readOverviewPrefs() {
        this._overviewWallpaper =
            this._settings?.get_boolean('overview-wallpaper') ?? true;
        this._overviewBlur = this._settings?.get_boolean('overview-blur') ?? true;
        this._overviewStrength = this._settings?.get_int('overview-blur-strength') ?? 30;
    }

    _onOverviewPrefsChanged() {
        this._readOverviewPrefs();
        for (const entry of this._overviewClones || [])
            this._applyOverviewBlur(entry.blurController);
        this._queueSync();
    }

    _applyOverviewBlur(controller) {
        const enabled = this._overviewWallpaper &&
            this._overviewBlur && this._overviewStrength > 0;
        controller?.setState(enabled, enabled, this._overviewStrength);
    }

    disable() {
        this._enabled = false;
        if (this._syncId) {
            GLib.source_remove(this._syncId);
            this._syncId = 0;
        }
        if (this._mapId) {
            global.window_manager.disconnect(this._mapId);
            this._mapId = 0;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        for (const id of this._overviewSettingsIds || []) {
            try { this._settings?.disconnect(id); } catch (_e) {}
        }
        this._overviewSettingsIds = [];
        this._injection.clear();
        for (const actor of this._sources.keys())
            this._unwatchRenderer(actor);
        this._desktopPresentation.clear();
        for (const [background, entry] of this._backgrounds) {
            background.disconnect(entry.removedId);
            background.disconnect(entry.destroyId);
            entry.actor?.destroy();
        }
        this._backgrounds.clear();
        this._teardownOverviewBackdrop();
        if (!Main.sessionMode.isLocked)
            this._reloadBackgrounds();
    }

    // --- Overview backdrop -------------------------------------------------
    // The overview is a component layered over the workspaces, so its own
    // background (the dark margin ring around the rounded workspace previews,
    // normally the stage-bottom SystemBackground) should read as a BLURRED
    // wallpaper — while the workspace previews themselves stay sharp, since
    // the wallpaper is a per-workspace concept. We drop a monitor-filling,
    // blurred renderer clone at the bottom of overviewGroup for those
    // margins; the opaque WorkspaceBackgrounds (carrying the sharp live
    // wallpaper via LiveWallpaper) sit above it and cover the center.
    // overviewGroup is hidden while the overview is closed, so these clones
    // only paint while it's open.
    _setupOverviewBackdrop() {
        this._overviewClones = [];
        this._overviewGroup = Main.layoutManager.overviewGroup;
        // BMS inserts its blur group at the bottom whenever children change.
        const reposition = () => this._repositionOverviewBackdrop();
        this._overviewChildAdded = this._overviewGroup.connect('child-added', reposition);
        this._overviewChildRemoved = this._overviewGroup.connect('child-removed', (_group, child) => {
            if (this._overviewClones.some(entry => entry.clone === child))
                this._queueSync();
            reposition();
        });
    }

    _bmsOverviewGroup() {
        try {
            return this._overviewGroup.get_children().find(
                c => c?.get_name?.() === 'bms-overview-backgroundgroup') ?? null;
        } catch (_e) {
            return null;
        }
    }

    _repositionOverviewBackdrop() {
        const group = this._overviewGroup;
        const bms = this._bmsOverviewGroup();
        for (const entry of this._overviewClones) {
            if (entry.clone.get_parent() !== group)
                continue;
            try {
                if (bms)
                    group.set_child_above_sibling(entry.clone, bms);
                else
                    group.set_child_below_sibling(entry.clone, null);
            } catch (_e) {}
        }
    }

    _invalidateOverviewClones() {
        const entries = this._overviewClones || [];
        this._overviewClones = [];
        for (const entry of entries) {
            entry.blurController?.destroy();
            try { this._overviewGroup?.remove_child(entry.clone); } catch (_e) {}
            try { entry.clone.destroy(); } catch (_e) {}
        }
    }

    _queueSync() {
        if (!this._enabled || this._syncId)
            return;
        // Finish the current destruction/layout pass before restoring children.
        this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._syncId = 0;
            try {
                this._syncRenderers();
            } catch (e) {
                logError(e, '[waywallen] Failed to synchronize wallpaper views');
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _watchRenderers(actors) {
        const owned = new Set(actors.filter(actor =>
            this._rendererLauncher?.ownsWindow(actor.meta_window)));
        for (const actor of this._sources.keys()) {
            if (!owned.has(actor))
                this._unwatchRenderer(actor);
        }
        for (const actor of owned) {
            if (this._sources.has(actor))
                continue;
            const changed = () => this._queueSync();
            this._sources.set(actor, [
                [actor.meta_window, actor.meta_window.connect('notify::title', changed)],
                [actor, actor.connect('first-frame', changed)],
                [actor, actor.connect('notify::width', changed)],
                [actor, actor.connect('notify::height', changed)],
                [actor, actor.connect('destroy', () => {
                    this._unwatchRenderer(actor);
                    this._queueSync();
                })],
            ]);
        }
    }

    _unwatchRenderer(actor) {
        for (const [object, id] of this._sources.get(actor) || [])
            object.disconnect(id);
        this._sources.delete(actor);
    }

    _syncRenderers() {
        const actors = global.display.list_all_windows()
            .map(window => window.get_compositor_private())
            .filter(actor => actor);
        this._watchRenderers(actors);
        const sources = Wallpaper.collectRenderers(actors,
            this._rendererAvailable ? this._rendererLauncher : null);
        for (const manager of Main.layoutManager._bgManagers) {
            if (manager.backgroundActor)
                this._ensureWallpaper(manager.backgroundActor, Wallpaper.WallpaperRole.Desktop);
        }
        for (const [background, entry] of this._backgrounds) {
            try {
                const actor = this._ensureWallpaper(background, entry.role);
                actor.syncRenderer(sources.get(actor.monitorIndex) ?? null);
            } catch (e) {
                logError(e, `[waywallen] Failed to synchronize background for monitor ${background.monitor}`);
            }
        }
        this._syncOverviewBackdrop(sources);
    }

    _ensureWallpaper(background, role) {
        let entry = this._backgrounds.get(background);
        if (!entry) {
            entry = {role, actor: null};
            this._backgrounds.set(background, entry);
            entry.removedId = background.connect('child-removed', (_parent, child) => {
                if (child === entry.actor)
                    this._queueSync();
            });
            entry.destroyId = background.connect('destroy', () => {
                this._backgrounds.delete(background);
                background.disconnect(entry.removedId);
                background.disconnect(entry.destroyId);
                entry.actor?.destroyWithBackground();
            });
        }
        if (!entry.actor) {
            entry.actor = new Wallpaper.LiveWallpaper(background, role, destroyed => {
                if (entry.actor === destroyed) {
                    entry.actor = null;
                    this._queueSync();
                }
            }, () => this._queueSync());
            if (role === Wallpaper.WallpaperRole.Desktop)
                this._applyPresentationToActor(entry.actor);
        }
        const actor = entry.actor;
        if (actor.get_parent() !== background) {
            actor.get_parent()?.remove_child(actor);
            background.add_child(actor);
        }
        return actor;
    }

    _syncOverviewBackdrop(sources) {
        if (!this._overviewWallpaper) {
            this._invalidateOverviewClones();
            return;
        }

        const group = this._overviewGroup;

        for (const [m, src] of sources) {
            const geom = global.display.get_monitor_geometry(m);
            let entry = this._overviewClones.find(c => c.monitor === m);
            if (!entry || entry.clone.source !== src) {
                if (entry) {
                    this._overviewClones = this._overviewClones.filter(c => c !== entry);
                    entry.blurController?.destroy();
                    try { group.remove_child(entry.clone); } catch (_e2) {}
                    try { entry.clone.destroy(); } catch (_e2) {}
                }
                const clone = new Clutter.Clone({
                    source: src,
                    opacity: 0,
                });
                const blurController = new BlurController(
                    clone, 'waywallen-overview-blur');
                this._applyOverviewBlur(blurController);
                group.add_child(clone);
                clone.ease({
                    opacity: 255, duration: 400,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                entry = {clone, monitor: m, blurController};
                clone.connect('destroy', () => {
                    if (!this._overviewClones.includes(entry))
                        return;
                    this._overviewClones = this._overviewClones.filter(c => c !== entry);
                    blurController.destroy();
                    this._queueSync();
                });
                this._overviewClones.push(entry);
            }
            if (entry.clone.get_parent() !== group) {
                entry.clone.get_parent()?.remove_child(entry.clone);
                group.add_child(entry.clone);
            }
            const sx = geom.width / src.width;
            const sy = geom.height / src.height;
            entry.clone.set_position(geom.x, geom.y);
            entry.clone.set_scale(sx, sy);
        }

        // Remove disconnected outputs and sources which are no longer valid
        // for that output, even if their old windows still exist.
        for (const entry of [...this._overviewClones]) {
            if (sources.get(entry.monitor) !== entry.clone.source) {
                this._overviewClones = this._overviewClones.filter(c => c !== entry);
                entry.blurController?.destroy();
                try { group.remove_child(entry.clone); } catch (_e) {}
                try { entry.clone.destroy(); } catch (_e) {}
            }
        }

        this._repositionOverviewBackdrop();
    }

    _teardownOverviewBackdrop() {
        try {
            for (const id of ['_overviewChildAdded', '_overviewChildRemoved']) {
                if (this[id]) {
                    try { this._overviewGroup?.disconnect(this[id]); } catch (_e) {}
                    this[id] = 0;
                }
            }
            this._invalidateOverviewClones();
        } catch (_e) {}
    }

    applyControlFrame(frame) {
        const key = this._geometryKey(frame.geometry);
        if (frame.type === 'reset') {
            this._desktopPresentation.delete(key);
            this._syncDesktopPresentation(key);
            return true;
        }

        if (frame.type === 'connection' || frame.type === 'presentation-snapshot') {
            const current = this._desktopPresentation.get(key);
            if (frame.type === 'presentation-snapshot' && !current)
                return false;
            if (current &&
                (frame.presentation.config.generation <= current.config.generation ||
                 frame.presentation.state.generation <=
                    current.state.generation))
                return false;
            this._desktopPresentation.set(key, frame.presentation);
            this._syncDesktopPresentation(key);
            return true;
        }

        const current = this._desktopPresentation.get(key);
        const state = frame.state;
        if (!current || state.configGeneration !== current.config.generation ||
            state.generation <= current.state.generation ||
            (current.config.pauseEffect.kind === PauseEffectKind.NONE &&
             state.pauseEffect.active))
            return false;
        current.state = state;
        this._syncDesktopPresentation(key);
        return true;
    }

    resetPresentation() {
        this._desktopPresentation.clear();
        for (const {actor} of this._backgrounds.values()) {
            if (actor?.role === Wallpaper.WallpaperRole.Desktop)
                actor.setPresentation(null);
        }
    }

    setRendererAvailable(available) {
        if (this._rendererAvailable === available)
            return;
        this._rendererAvailable = available;
        this._queueSync();
    }

    setRendererLauncher(launcher) {
        if (this._rendererLauncher === launcher)
            return;
        this._rendererLauncher = launcher;
        this._queueSync();
    }

    _geometryKey(geometry) {
        return `${geometry.x}:${geometry.y}:${geometry.width}:${geometry.height}`;
    }

    _actorGeometryKey(actor) {
        const geometry = global.display.get_monitor_geometry(actor.monitorIndex);
        return this._geometryKey(geometry);
    }

    _applyPresentationToActor(actor) {
        let presentation = null;
        try {
            presentation = this._desktopPresentation.get(this._actorGeometryKey(actor)) ?? null;
        } catch (_e) {}
        actor.setPresentation(presentation);
    }

    _syncDesktopPresentation(key) {
        for (const {actor} of this._backgrounds.values()) {
            if (actor?.role !== Wallpaper.WallpaperRole.Desktop)
                continue;
            try {
                if (this._actorGeometryKey(actor) === key)
                    this._applyPresentationToActor(actor);
            } catch (_e) {}
        }
    }

    _reloadBackgrounds() {
        Main.layoutManager._updateBackgrounds()?.catch(e =>
            logError(e, '[waywallen] Failed to reload desktop backgrounds'));
        // BMS may create its own panel backgrounds before our deferred hook.
        // Recreate them when installing or removing the wallpaper override.
        for (const panel of global.blur_my_shell?._panel_blur?.actors_list ?? []) {
            try {
                if (panel.static_blur && panel.bg_manager?.backgroundActor)
                    panel.bg_manager._updateBackgroundActor();
            } catch (e) {
                console.warn(`[waywallen] Failed to reload Blur my Shell panel background: ${e}`);
            }
        }
        if (Main.screenShield?._dialog?._updateBackgrounds)
            Main.screenShield._dialog._updateBackgrounds();
        try {
            Main.overview._overview._controls
                ._workspacesDisplay._updateWorkspacesViews();
        } catch (_e) {
            // Other extensions may have already torn down workspace views.
        }
    }
}
