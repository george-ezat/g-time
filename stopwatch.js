import GLib from "gi://GLib";
import St from "gi://St";
import Clutter from "gi://Clutter";
import { gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";

const CIRCLE_SIZE = 250;
const STROKE_WIDTH = 8;

export class Stopwatch {
  constructor(indicator) {
    this._indicator = indicator;
    this.seconds = 0;
    this.startTime = null;
    this.timerId = null;
    this._animTimerId = null;
    this._pausedElapsedMs = 0;

    this.container = this._buildUi();
  }

  loadState(state) {
    const now = GLib.DateTime.new_now_local().to_unix();
    if (state.stopwatchStartTime && state.stopwatchTimerActive) {
      this.seconds = Math.max(0, now - state.stopwatchStartTime);
      this._pausedElapsedMs = this.seconds * 1000;
      this._toggleStopwatch();
    } else if (state.stopwatchSeconds) {
      this.seconds = state.stopwatchSeconds;
      this._pausedElapsedMs = this.seconds * 1000;
    }
    this._renderStopwatch();
  }

  getState() {
    const now = GLib.DateTime.new_now_local().to_unix();
    return {
      stopwatchSeconds: this.seconds,
      stopwatchTimerActive: !!this.timerId,
      stopwatchStartTime: this.timerId
        ? (this.startTime ?? now - this.seconds)
        : null,
    };
  }

  stop() {
    if (this.timerId) {
      GLib.source_remove(this.timerId);
      this.timerId = null;
    }
    if (this._animTimerId) {
      GLib.source_remove(this._animTimerId);
      this._animTimerId = null;
    }
  }

  _buildUi() {
    const container = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "gtime-circle-wrapper",
    });

    const dialOverlay = new St.Widget({
      layout_manager: new Clutter.BinLayout(),
      width: CIRCLE_SIZE,
      height: CIRCLE_SIZE,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });

    this._circleCanvas = new St.DrawingArea({
      width: CIRCLE_SIZE,
      height: CIRCLE_SIZE,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.FILL,
    });
    this._circleCanvas.connect("repaint", (area) => this._drawCircle(area));

    const innerContent = new St.BoxLayout({
      vertical: true,
      style_class: "gtime-circle-inner",
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });

    this._stopwatchLabel = new St.Label({
      text: "00:00",
      style_class: "gtime-circle-time-label",
      x_align: Clutter.ActorAlign.CENTER,
    });

    this._stopwatchSubtitle = new St.Label({
      text: _("Ready"),
      style_class: "gtime-circle-subtitle",
      x_align: Clutter.ActorAlign.CENTER,
    });

    const actionsRow = new St.BoxLayout({
      style_class: "gtime-circle-actions-row",
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });

    this._stopwatchStartIcon = new St.Icon({
      icon_name: "media-playback-start-symbolic",
      icon_size: 18,
    });

    this._stopwatchStartBtn = new St.Button({
      style_class: "gtime-play-button",
      can_focus: true,
      y_align: Clutter.ActorAlign.CENTER,
      child: this._stopwatchStartIcon,
    });
    this._stopwatchStartBtn.connect(
      "clicked",
      this._toggleStopwatch.bind(this),
    );

    this._stopwatchResetBtn = new St.Button({
      style_class: "gtime-reset-button",
      can_focus: true,
      reactive: false,
      y_align: Clutter.ActorAlign.CENTER,
      child: new St.Icon({ icon_name: "view-refresh-symbolic", icon_size: 18 }),
    });
    this._stopwatchResetBtn.add_style_class_name("gtime-reset-button-disabled");
    this._stopwatchResetBtn.connect("clicked", this._resetStopwatch.bind(this));

    actionsRow.add_child(this._stopwatchStartBtn);
    actionsRow.add_child(this._stopwatchResetBtn);

    innerContent.add_child(this._stopwatchLabel);
    innerContent.add_child(this._stopwatchSubtitle);
    innerContent.add_child(actionsRow);

    dialOverlay.add_child(this._circleCanvas);
    dialOverlay.add_child(innerContent);
    container.add_child(dialOverlay);

    return container;
  }

  _getElapsedMs() {
    if (this.timerId && this._startTimeMs) {
      const nowMs = GLib.get_real_time() / 1000;
      return Math.max(0, nowMs - this._startTimeMs);
    }
    return this._pausedElapsedMs || this.seconds * 1000;
  }

  _drawCircle(area) {
    const cr = area.get_context();
    const [width, height] = area.get_surface_size();
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(cx, cy) - STROKE_WIDTH - 4;

    cr.setOperator(2); // Cairo.Operator.OVER

    // 1. Subtle inner glass fill
    cr.arc(cx, cy, radius - STROKE_WIDTH / 2, 0, 2 * Math.PI);
    cr.setSourceRGBA(1, 1, 1, 0.03);
    cr.fill();

    // 2. Background circular track
    cr.setLineWidth(STROKE_WIDTH);
    cr.arc(cx, cy, radius, 0, 2 * Math.PI);
    cr.setSourceRGBA(1, 1, 1, 0.1);
    cr.stroke();

    // 3. Smooth sub-second chronograph sweep with seamless minute rollover:
    // Even minutes (0..1, 2..3): fills clockwise from top (-PI/2 to -PI/2 + progress * 2PI)
    // Odd minutes (1..2, 3..4): wipes/unfills clockwise from top (-PI/2 + progress * 2PI to 3PI/2)
    const elapsedMs = this._getElapsedMs();
    if (elapsedMs > 0) {
      const totalMinutes = Math.floor(elapsedMs / 60000);
      const progress = (elapsedMs % 60000) / 60000;
      const topAngle = -Math.PI / 2;
      const fullCircleAngle = topAngle + 2 * Math.PI;

      if (this.timerId) {
        cr.setSourceRGBA(0.208, 0.518, 0.894, 1.0); // GNOME Blue (#3584e4)
      } else {
        cr.setSourceRGBA(0.208, 0.518, 0.894, 0.55);
      }

      cr.setLineCap(1);
      cr.setLineWidth(STROKE_WIDTH);

      if (totalMinutes % 2 === 0) {
        // Filling clockwise
        const endAngle = topAngle + progress * 2 * Math.PI;
        if (progress > 0.001) {
          cr.arc(cx, cy, radius, topAngle, endAngle);
          cr.stroke();
        }
      } else {
        // Unfilling clockwise
        const startAngle = topAngle + progress * 2 * Math.PI;
        if (progress < 0.999) {
          cr.arc(cx, cy, radius, startAngle, fullCircleAngle);
          cr.stroke();
        }
      }
    }

    cr.$dispose();
  }

  _renderStopwatch() {
    const h = Math.floor(this.seconds / 3600);
    const m = Math.floor((this.seconds % 3600) / 60);
    const s = this.seconds % 60;
    const pad = (n) => n.toString().padStart(2, "0");

    if (h > 0) {
      this._stopwatchLabel.set_text(`${pad(h)}:${pad(m)}:${pad(s)}`);
      this._stopwatchLabel.add_style_class_name(
        "gtime-circle-time-label-hours",
      );
    } else {
      this._stopwatchLabel.set_text(`${pad(m)}:${pad(s)}`);
      this._stopwatchLabel.remove_style_class_name(
        "gtime-circle-time-label-hours",
      );
    }

    if (this._stopwatchSubtitle) {
      if (this.timerId) {
        this._stopwatchSubtitle.set_text(_("Running"));
      } else if (this.seconds > 0) {
        this._stopwatchSubtitle.set_text(_("Paused"));
      } else {
        this._stopwatchSubtitle.set_text(_("Ready"));
      }
    }

    if (this._stopwatchResetBtn) {
      const canReset = this.timerId || this.seconds > 0;
      this._stopwatchResetBtn.reactive = Boolean(canReset);
      this._stopwatchResetBtn.can_focus = Boolean(canReset);
      if (canReset) {
        this._stopwatchResetBtn.remove_style_class_name(
          "gtime-reset-button-disabled",
        );
      } else {
        this._stopwatchResetBtn.add_style_class_name(
          "gtime-reset-button-disabled",
        );
      }
    }

    if (this._circleCanvas) {
      this._circleCanvas.queue_repaint();
    }

    this._indicator.updatePanelFromMode();
  }

  _toggleStopwatch() {
    const nowMs = GLib.get_real_time() / 1000;
    if (this.timerId) {
      if (this._startTimeMs) {
        this._pausedElapsedMs = Math.max(0, nowMs - this._startTimeMs);
        this.seconds = Math.floor(this._pausedElapsedMs / 1000);
      }
      this.startTime = null;
      this._startTimeMs = null;
      this.stop();
      this._stopwatchStartIcon.icon_name = "media-playback-start-symbolic";
      this._stopwatchStartBtn.remove_style_class_name(
        "gtime-play-button-paused",
      );
      this._renderStopwatch();
    } else {
      const baseMs = this._pausedElapsedMs || this.seconds * 1000;
      this._startTimeMs = nowMs - baseMs;
      this.startTime = Math.floor(this._startTimeMs / 1000);
      this._stopwatchStartIcon.icon_name = "media-playback-pause-symbolic";
      this._stopwatchStartBtn.add_style_class_name("gtime-play-button-paused");

      this.timerId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        1000,
        this._tickStopwatch.bind(this),
      );
      GLib.Source.set_name_by_id(this.timerId, "[g-time] stopwatch");

      // Smooth 60ms repaint for the circular ring when the menu is open
      this._animTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
        if (this._circleCanvas && this._indicator.menu.isOpen) {
          this._circleCanvas.queue_repaint();
        }
        return GLib.SOURCE_CONTINUE;
      });
      GLib.Source.set_name_by_id(this._animTimerId, "[g-time] stopwatch-anim");
      this._renderStopwatch();
    }
    this._indicator.queueSave();
  }

  _tickStopwatch() {
    if (this._startTimeMs) {
      const nowMs = GLib.get_real_time() / 1000;
      this.seconds = Math.max(
        0,
        Math.round((nowMs - this._startTimeMs) / 1000),
      );
    } else {
      this.seconds++;
    }
    this._renderStopwatch();
    return GLib.SOURCE_CONTINUE;
  }

  _resetStopwatch() {
    this.stop();
    this.seconds = 0;
    this._pausedElapsedMs = 0;
    this.startTime = null;
    this._startTimeMs = null;
    this._stopwatchStartIcon.icon_name = "media-playback-start-symbolic";
    this._stopwatchStartBtn.remove_style_class_name("gtime-play-button-paused");
    this._renderStopwatch();
    this._indicator.queueSave();
  }
}
