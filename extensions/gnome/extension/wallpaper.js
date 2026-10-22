// Holds a Clutter.Clone of the renderer's MetaWindowActor for one
// monitor. Inserted as a child of the original Background actor by
// gnomeShellOverride, so it follows the desktop's z-order, rounded
// corners (in workspace overview) and lifetime automatically.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Graphene from 'gi://Graphene';

import {BlurController} from './blur.js';
import {PauseEffectKind} from './controlCodec.js';

export const APPLICATION_ID = 'io.github.waywallen.WaywallenRenderer';
const TITLE_PREFIX = `@${APPLICATION_ID}!`;

export const WallpaperRole = Object.freeze({
    Desktop: 'desktop',
    Other: 'other',
});

function rendererHints(actor) {
    const title = actor?.meta_window?.title;
    if (!title?.startsWith(TITLE_PREFIX))
        return null;
    const payload = title.slice(TITLE_PREFIX.length).split('|', 1)[0];
    try {
        return JSON.parse(payload);
    } catch (_e) {
        return null;
    }
}

// A source window can migrate to another output when its monitor disappears.
// Match its advertised output, never its current MetaWindow monitor index.
export function collectRenderers(actors, launcher) {
    const matches = new Map();
    if (!launcher)
        return matches;
    const manager = global.backend.get_monitor_manager();
    const geometries = Array.from({length: global.display.get_n_monitors()},
        (_, index) => global.display.get_monitor_geometry(index));
    for (const actor of actors) {
        if (!launcher.ownsWindow(actor.meta_window))
            continue;
        const hints = rendererHints(actor);
        if (hints?.presentationReady !== true || actor.width <= 0 || actor.height <= 0)
            continue;
        const index = hints.connector
            ? manager.get_monitor_for_connector(hints.connector)
            : geometries.findIndex(geometry => hints.geometry &&
                ['x', 'y', 'width', 'height'].every(key => hints.geometry[key] === geometry[key]));
        if (index >= 0 && index < geometries.length)
            matches.set(index, matches.has(index) ? null : actor);
    }
    return new Map([...matches].filter(([, actor]) => actor));
}

const FADE_IN_MS = 800;

export const LiveWallpaper = GObject.registerClass(
class LiveWallpaper extends St.Widget {
    _init(backgroundActor, role = WallpaperRole.Other, onDestroyed = null, onChanged = null) {
        super._init({
            // FixedLayout: we position the clone ourselves in vfunc_allocate
            // (top-left origin, scaled to fill). BinLayout centered the
            // monitor-sized clone inside the smaller overview preview box,
            // which misaligned it and made it collapse when the preview
            // shrank for the app grid.
            layout_manager: new Clutter.FixedLayout(),
            // No explicit width/height: MetaBackgroundActor is content-driven,
            // and its width/height props are 0 in the overview. We expand to
            // fill whatever the parent allocates and report no preferred size
            // (see vfuncs) so we don't distort the overview workspace layout.
            x_expand: true,
            y_expand: true,
            opacity: role === WallpaperRole.Desktop ? 255 : 0,
        });
        this._backgroundActor = backgroundActor;
        this._monitorIndex = backgroundActor.monitor;
        this._role = role;
        this._presentation = null;
        this._blurController = null;
        this._wwDestroyed = false;
        this._onDestroyed = onDestroyed;
        this._onChanged = onChanged;
        this._destroyId = this.connect('destroy', () => this._cleanup());
        this.connect('child-removed', (_parent, child) => {
            if (child === this._cloneActor)
                this._onChanged?.();
        });

        backgroundActor.layout_manager = new Clutter.BinLayout();
        backgroundActor.add_child(this);

        this._cloneActor = null;
        this._cloneDestroyId = 0;
        this._sourceActor = null;
        this._sourceDestroyId = 0;
        if (this._role === WallpaperRole.Desktop)
            this.set_style('background-color: black;');
        this._showFallback();
    }

    // Report no preferred size: the clone's natural (monitor) size would
    // otherwise feed back into the overview workspace-preview layout and
    // distort it.
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }
    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }

    // Scale the clone from the top-left to fill our ACTUAL allocation. The
    // backing actor's width/height props stay 0 in the content-driven overview
    // path, so the allocation box is the source of truth. Pinning to (0,0)
    // with pivot (0,0) fills the preview exactly in both the desktop and the
    // overview (including when the preview shrinks for the app grid).
    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        const clone = this._cloneActor;
        if (clone && clone.source && clone.source.width > 0) {
            const sx = box.get_width() / clone.source.width;
            const sy = box.get_height() / clone.source.height;
            clone.set_position(0, 0);
            if (Math.abs((clone.scale_x ?? 1) - sx) > 0.001 ||
                Math.abs((clone.scale_y ?? 1) - sy) > 0.001)
                clone.set_scale(sx, sy);
        }
    }

    syncRenderer(renderer) {
        if (this._wwDestroyed)
            return;
        if (renderer && renderer === this._sourceActor && this._cloneActor) {
            if (this._cloneActor.get_parent() !== this) {
                this._cloneActor.get_parent()?.remove_child(this._cloneActor);
                this.add_child(this._cloneActor);
            }
            return;
        }
        this._detachRenderer();
        this._showFallback();
        if (renderer) {
            // Shell owns the transition for overview and lock-screen views.
            this._cloneActor = new Clutter.Clone({
                source: renderer,
                opacity: this._role === WallpaperRole.Desktop ? 0 : 255,
            });
            this._cloneDestroyId = this._cloneActor.connect('destroy', () => {
                this._cloneActor = null;
                this._cloneDestroyId = 0;
                this._detachRenderer();
                this._showFallback();
                this._onChanged?.();
            });
            this._sourceActor = renderer;
            this._sourceDestroyId = renderer.connect('destroy',
                () => this._onSourceDestroyed());
            this.add_child(this._cloneActor);
            if (this._role === WallpaperRole.Desktop) {
                this._blurController = new BlurController(
                    this._cloneActor, 'waywallen-desktop-blur');
                this._applyPresentation();
                this._cloneActor.ease({
                    opacity: 255,
                    duration: FADE_IN_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
            this.opacity = 255;
            // Black out the gsettings placeholder behind us (see _dimBackdrop).
            this._dimBackdrop(true);
            // No redraw timer: Clutter.Clone repaints on the source's
            // queue-redraw, i.e. exactly when the renderer commits a buffer.
            return;
        }
    }

    // The gsettings MetaBackground behind us is a placeholder solid color.
    // Where the clone has alpha or at clip edges it bleeds through as a
    // colored veil — most visible in the overview workspace preview, which
    // renders that content at brightness 0.5. While we are actively covering
    // the actor, pin the backdrop to black so any bleed reads as shadow.
    // Non-desktop backgrounds restore their normal brightness when the source
    // goes away; the desktop keeps the disconnected fallback black.
    _dimBackdrop(dim) {
        try {
            const content = this._backgroundActor?.content;
            if (!content)
                return;
            if (dim) {
                if (this._origBrightness === undefined) {
                    this._origBrightness = content.brightness;
                    this._origVignette = content.vignette;
                }
                // Mutter only applies brightness when vignette is enabled
                // (see meta-background-content.c); without this line the
                // dim is a no-op on overview workspace previews and the
                // gsettings wallpaper bleeds through the clone's alpha.
                content.vignette = true;
                content.brightness = 0;
            } else if (this._origBrightness !== undefined) {
                content.vignette = this._origVignette;
                content.brightness = this._origBrightness;
                this._origBrightness = undefined;
                this._origVignette = undefined;
            }
        } catch (_e) {}
    }

    _onSourceDestroyed() {
        this._sourceDestroyId = 0;
        this._sourceActor = null;
        this._detachRenderer();
        this._showFallback();
        this._onChanged?.();
    }

    _detachRenderer() {
        if (this._sourceActor && this._sourceDestroyId)
            this._sourceActor.disconnect(this._sourceDestroyId);
        this._sourceActor = null;
        this._sourceDestroyId = 0;
        this._blurController?.destroy();
        this._blurController = null;
        if (this._cloneActor) {
            const clone = this._cloneActor;
            this._cloneActor = null;
            if (this._cloneDestroyId) {
                try { clone.disconnect(this._cloneDestroyId); } catch (_e) {}
                this._cloneDestroyId = 0;
            }
            try { clone.destroy(); } catch (_e) {}
        }
    }

    _showFallback() {
        if (this._wwDestroyed)
            return;
        this._cloneActor?.remove_all_transitions();
        if (this._cloneActor)
            this._cloneActor.opacity = 0;
        if (this._role === WallpaperRole.Desktop) {
            this.opacity = 255;
            this._dimBackdrop(true);
        } else {
            this.opacity = 0;
            this._dimBackdrop(false);
        }
    }

    destroyWithBackground() {
        // The owner is disposing the parent; its content is no longer readable.
        this._backgroundActor = null;
        this.destroy();
    }

    setPresentation(presentation) {
        if (this._wwDestroyed || this._role !== WallpaperRole.Desktop)
            return;
        this._presentation = presentation;
        this._applyPresentation();
    }

    get role() {
        return this._role;
    }

    get monitorIndex() {
        return this._monitorIndex;
    }

    _applyPresentation() {
        const presentation = this._presentation;
        if (!presentation) {
            this._blurController?.setState(false, false, 30);
            return;
        }
        this._blurController?.setState(
            presentation.config.pauseEffect.kind === PauseEffectKind.BLUR,
            presentation.state.pauseEffect.active,
            presentation.config.pauseEffect.blur.radius);
    }

    _cleanup() {
        if (this._wwDestroyed)
            return;
        this._wwDestroyed = true;
        this._onChanged = null;
        const onDestroyed = this._onDestroyed;
        this._onDestroyed = null;
        onDestroyed?.(this);
        this._detachRenderer();
        this._dimBackdrop(false);
        this._backgroundActor = null;
        this._presentation = null;
        if (this._destroyId) {
            this.disconnect(this._destroyId);
            this._destroyId = 0;
        }
    }
});
