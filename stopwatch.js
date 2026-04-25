import GLib from "gi://GLib";
import St from "gi://St";
import Clutter from "gi://Clutter";
import { gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";

export class Stopwatch {
  constructor(indicator) {
    this._indicator = indicator;
    this.seconds = 0;
    this.timerId = null;

    this.container = this._buildUi();
  }

  loadState(state) {
    const now = GLib.DateTime.new_now_local().to_unix();
    if (state.stopwatchStartTime && state.stopwatchTimerActive) {
      this.seconds = Math.max(0, now - state.stopwatchStartTime);
      this._toggleStopwatch();
    } else if (state.stopwatchSeconds) {
      this.seconds = state.stopwatchSeconds;
    }
    this._renderStopwatch();
  }

  getState() {
    const now = GLib.DateTime.new_now_local().to_unix();
    return {
      stopwatchSeconds: this.seconds,
      stopwatchTimerActive: !!this.timerId,
      stopwatchStartTime: this.timerId ? now - this.seconds : null,
    };
  }

  stop() {
    if (this.timerId) {
      GLib.source_remove(this.timerId);
      this.timerId = null;
    }
  }

  _buildUi() {
    const container = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      y_expand: true,
    });

    container.add_child(new St.Widget({ y_expand: true }));

    this._stopwatchLabel = new St.Label({
      text: "00:00:00",
      style_class: "gtime-stopwatch-display",
      x_align: Clutter.ActorAlign.CENTER,
    });
    container.add_child(this._stopwatchLabel);

    container.add_child(new St.Widget({ y_expand: true }));

    const actionsRow = new St.BoxLayout({
      style_class: "gtime-actions-row",
      x_align: 2,
    });

    this._stopwatchStartBtn = new St.Button({
      label: _("Start"),
      style_class: "gtime-start-button",
      can_focus: true,
    });
    this._stopwatchStartBtn.connect(
      "clicked",
      this._toggleStopwatch.bind(this),
    );

    this._stopwatchResetBtn = new St.Button({
      style_class: "gtime-reset-button",
      can_focus: true,
      reactive: false,
      child: new St.Icon({ icon_name: "view-refresh-symbolic", icon_size: 16 }),
    });
    this._stopwatchResetBtn.add_style_class_name("gtime-reset-button-disabled");
    this._stopwatchResetBtn.connect("clicked", this._resetStopwatch.bind(this));

    actionsRow.add_child(this._stopwatchStartBtn);
    actionsRow.add_child(this._stopwatchResetBtn);
    container.add_child(actionsRow);

    return container;
  }

  _renderStopwatch() {
    const h = Math.floor(this.seconds / 3600);
    const m = Math.floor((this.seconds % 3600) / 60);
    const s = this.seconds % 60;
    this._stopwatchLabel.set_text(
      `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`,
    );

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

    this._indicator.updatePanelFromMode();
  }

  _toggleStopwatch() {
    if (this.timerId) {
      this.stop();
      this._stopwatchStartBtn.label = _("Resume");
      this._stopwatchStartBtn.remove_style_class_name(
        "gtime-start-button-paused",
      );
    } else {
      this._stopwatchStartBtn.label = _("Pause");
      this._stopwatchStartBtn.add_style_class_name("gtime-start-button-paused");

      this.timerId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        1,
        this._tickStopwatch.bind(this),
      );
      GLib.Source.set_name_by_id(this.timerId, "[g-time] stopwatch");
      this._indicator.updatePanelFromMode();
    }
    this._indicator.queueSave();
  }

  _tickStopwatch() {
    this.seconds++;
    this._renderStopwatch();
    return GLib.SOURCE_CONTINUE;
  }

  _resetStopwatch() {
    this.stop();
    this.seconds = 0;
    this._stopwatchStartBtn.label = _("Start");
    this._stopwatchStartBtn.remove_style_class_name(
      "gtime-start-button-paused",
    );
    this._renderStopwatch();
    this._indicator.queueSave();
  }
}
