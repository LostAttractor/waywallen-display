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
        this._wallpapers = new Map(); // Background actor -> owned wallpaper.
        this._desktopPresentation = new Map();
        this._rendererAvailable = false;
        this._rendererLauncher = null;
    }

    enable() {
        const self = this;

        this._injection.overrideMethod(
            Background.BackgroundManager.prototype,
            '_createBackgroundActor',
            originalMethod => function () {
                const backgroundActor = originalMethod.call(this);
                const role = this._container === Main.layoutManager._backgroundGroup
                    ? Wallpaper.WallpaperRole.Desktop
                    : Wallpaper.WallpaperRole.Other;
                this.waywallenActor = self._ensureWallpaper(backgroundActor, role);
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
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._invalidateOverviewClones();
            this._syncRenderers();
        });

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
        try { this._syncOverviewBackdrop(); } catch (_e) {}
    }

    _applyOverviewBlur(controller) {
        const enabled = this._overviewWallpaper &&
            this._overviewBlur && this._overviewStrength > 0;
        controller?.setState(enabled, enabled, this._overviewStrength);
    }

    disable() {
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        for (const id of this._overviewSettingsIds || []) {
            try { this._settings?.disconnect(id); } catch (_e) {}
        }
        this._overviewSettingsIds = [];
        this._injection.clear();
        const actors = [...this._wallpapers.values()];
        this._wallpapers.clear();
        this._desktopPresentation.clear();
        for (const a of actors) {
            try { a.destroy(); } catch (_e) {}
        }
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
        try {
            this._overviewClones = [];
            this._overviewGroup = Main.layoutManager.overviewGroup;
            this._rendererPollId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, 1000, () => {
                    try { this._syncRenderers(); } catch (_e) {}
                    return GLib.SOURCE_CONTINUE;
                });
            try { this._syncRenderers(); } catch (_e) {}
            // Keep our clones correctly stacked: just above blur-my-shell's
            // overview background group if present (so our wallpaper shows
            // over its static blur), otherwise at the very bottom. Re-evaluate
            // on any structural change, because blur-my-shell re-inserts its
            // own group at index 0 whenever another child is added.
            const reposition = () => {
                try { this._repositionOverviewBackdrop(); } catch (_e) {}
            };
            this._overviewChildAdded = this._overviewGroup.connect('child-added', reposition);
            this._overviewChildRemoved = this._overviewGroup.connect('child-removed', reposition);
        } catch (_e) {}
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

    _syncRenderers() {
        // The current GNOME background is authoritative, even if its child
        // was removed or the background predates our creation hook.
        for (const manager of Main.layoutManager._bgManagers) {
            if (manager.backgroundActor)
                manager.waywallenActor = this._ensureWallpaper(
                    manager.backgroundActor, Wallpaper.WallpaperRole.Desktop);
        }
        // Output identities can settle after monitors-changed while source
        // windows survive, so every view must reconcile its current binding.
        for (const actor of this._wallpapers.values())
            actor.syncRenderer();
        this._syncOverviewBackdrop();
    }

    _ensureWallpaper(background, role) {
        const existing = this._wallpapers.get(background);
        if (existing)
            return existing;
        const actor = new Wallpaper.LiveWallpaper(
            background, role, this._rendererAvailable, this._rendererLauncher,
            destroyed => {
                if (this._wallpapers.get(background) === destroyed)
                    this._wallpapers.delete(background);
            });
        this._wallpapers.set(background, actor);
        if (role === Wallpaper.WallpaperRole.Desktop)
            this._applyPresentationToActor(actor);
        return actor;
    }

    _syncOverviewBackdrop() {
        if (!this._overviewWallpaper || !this._rendererAvailable || !this._rendererLauncher) {
            this._invalidateOverviewClones();
            return;
        }

        const group = this._overviewGroup;

        const currentSources = new Map();
        const nMonitors = global.display.get_n_monitors();

        for (let m = 0; m < nMonitors; m++) {
            const src = Wallpaper.findRendererForMonitor(m, this._rendererLauncher);
            if (!src || src.width <= 0)
                continue;
            currentSources.set(m, src);
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
                this._overviewClones.push(entry);
            }
            const sx = geom.width / src.width;
            const sy = geom.height / src.height;
            entry.clone.set_position(geom.x, geom.y);
            entry.clone.set_scale(sx, sy);
        }

        // Remove disconnected outputs and sources which are no longer valid
        // for that output, even if their old windows still exist.
        for (const entry of [...this._overviewClones]) {
            if (currentSources.get(entry.monitor) !== entry.clone.source) {
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
            if (this._rendererPollId) {
                GLib.source_remove(this._rendererPollId);
                this._rendererPollId = 0;
            }
            for (const id of ['_overviewChildAdded', '_overviewChildRemoved']) {
                if (this[id]) {
                    try { this._overviewGroup?.disconnect(this[id]); } catch (_e) {}
                    this[id] = 0;
                }
            }
            for (const entry of [...(this._overviewClones || [])]) {
                entry.blurController?.destroy();
                try { this._overviewGroup?.remove_child(entry.clone); } catch (_e) {}
                try { entry.clone.destroy(); } catch (_e) {}
            }
            this._overviewClones = [];
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
        for (const actor of this._wallpapers.values()) {
            if (actor.role === Wallpaper.WallpaperRole.Desktop)
                actor.setPresentation(null);
        }
    }

    setRendererAvailable(available) {
        if (this._rendererAvailable === available)
            return;
        this._rendererAvailable = available;
        for (const actor of this._wallpapers.values()) {
            try { actor.setRendererAvailable(available); } catch (_e) {}
        }
        this._syncOverviewBackdrop();
    }

    setRendererLauncher(launcher) {
        if (this._rendererLauncher === launcher)
            return;
        this._invalidateOverviewClones();
        this._rendererLauncher = launcher;
        for (const actor of this._wallpapers.values()) {
            try { actor.setRendererLauncher(launcher); } catch (_e) {}
        }
        this._syncOverviewBackdrop();
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
        for (const actor of this._wallpapers.values()) {
            if (actor.role !== Wallpaper.WallpaperRole.Desktop)
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
