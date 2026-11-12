import GLib from "gi://GLib";
import St from "gi://St";
import Clutter from "gi://Clutter";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as MessageTray from "resource:///org/gnome/shell/ui/messageTray.js";
import { gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";
import {
  MAX_HOURS,
  MAX_MINUTES_OR_SECONDS,
  TIME_PARTS,
  WARNING_SECONDS_THRESHOLD,
  CRITICAL_SECONDS_THRESHOLD,
} from "./constants.js";

const CIRCLE_SIZE = 250;
const STROKE_WIDTH = 8;

export class Timer {
  constructor(indicator) {
    this._indicator = indicator;
    this.time = { hours: 0, minutes: 0, seconds: 0 };
    this.timerId = null;
    this.remainingSeconds = 0;
    this.endTime = null;
    this.triggered = false;
    this._lastDurationSeconds = 0;
    this._animTimerId = null;
    this._pausedRemainingMs = 0;

    this._columns = new Map();
    this._valueLabels = new Map();
    this._editableButtons = [];
    this._editableEntries = [];
    this._isSyncingEntries = false;

    this.container = this._buildUi();
  }

  loadState(state) {
    const now = GLib.DateTime.new_now_local().to_unix();
    if (state.time) this.time = state.time;
    if (state.timerTriggered) this.triggered = state.timerTriggered;
    if (state.lastDurationSeconds) {
      this._lastDurationSeconds = state.lastDurationSeconds;
    }

    if (state.endTime) {
      this.remainingSeconds = Math.max(0, state.endTime - now);
      if (!this._lastDurationSeconds && this.remainingSeconds > 0) {
        this._lastDurationSeconds = this.remainingSeconds;
      }
      if (this.remainingSeconds > 0) this._toggleTimer();
      else {
        this.remainingSeconds = 0;
        this._finishTimer();
      }
    } else if (state.remainingSeconds) {
      this.remainingSeconds = state.remainingSeconds;
      this._pausedRemainingMs = this.remainingSeconds * 1000;
      if (!this._lastDurationSeconds) {
        this._lastDurationSeconds = this.remainingSeconds;
      }
    }

    this._renderTime();
    this._updateStartButtonState();
  }

  getState() {
    const now = GLib.DateTime.new_now_local().to_unix();
    return {
      time: this.time,
      remainingSeconds: this.remainingSeconds,
      lastDurationSeconds: this._lastDurationSeconds,
      endTime: this.timerId ? now + this.remainingSeconds : null,
      timerTriggered: this.triggered,
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
    if (this._autoDismissId) {
      GLib.source_remove(this._autoDismissId);
      this._autoDismissId = null;
    }
  }

  _buildUi() {
    const container = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      y_expand: true,
    });

    // =========================================================================
    // 1. SETUP VIEW (Quick Start + Picker Columns + Bottom Start/Reset)
    // =========================================================================
    this._setupView = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      y_expand: true,
      reactive: true,
    });

    this._setupView.connect("button-press-event", () => {
      this._setupView.grab_key_focus();
      this._setActiveColumn(null);
      return Clutter.EVENT_PROPAGATE;
    });

    this._setupView.add_child(
      new St.Label({
        text: _("Quick Start"),
        style_class: "gtime-section-title",
        x_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
      }),
    );

    const quickGrid = new St.BoxLayout({
      vertical: true,
      style_class: "gtime-quick-grid",
      x_expand: true,
    });

    const quickRows = [
      [
        { label: "+5 m", h: 0, m: 5, s: 0 },
        { label: "+10 m", h: 0, m: 10, s: 0 },
        { label: "+15 m", h: 0, m: 15, s: 0 },
        { label: "+20 m", h: 0, m: 20, s: 0 },
      ],
      [
        { label: "+30 m", h: 0, m: 30, s: 0 },
        { label: "+45 m", h: 0, m: 45, s: 0 },
        { label: "+1 h", h: 1, m: 0, s: 0 },
        { label: "+2 h", h: 2, m: 0, s: 0 },
      ],
    ];

    for (const rowItems of quickRows) {
      const row = new St.BoxLayout({
        style_class: "gtime-quick-row",
        x_expand: true,
      });

      for (const item of rowItems) {
        const button = new St.Button({
          label: item.label,
          style_class: "gtime-quick-button",
          x_expand: true,
          can_focus: true,
        });

        button.connect("clicked", () => {
          if (this.remainingSeconds > 0) return;
          this._setActiveColumn(null);
          let currentTotal =
            this.time.hours * 3600 + this.time.minutes * 60 + this.time.seconds;
          let addTotal = item.h * 3600 + item.m * 60 + item.s;
          let newTotal = currentTotal + addTotal;
          let newH = Math.min(MAX_HOURS, Math.floor(newTotal / 3600));
          let newM = Math.floor((newTotal % 3600) / 60);
          let newS = newTotal % 60;
          this._setTime(newH, newM, newS);
        });

        this._registerEditableButton(button);
        row.add_child(button);
      }

      quickGrid.add_child(row);
    }

    this._setupView.add_child(quickGrid);

    this._setupView.add_child(
      new St.Label({
        text: _("Set Timer"),
        style_class: "gtime-section-title gtime-section-title-spaced",
        x_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
      }),
    );

    const pickerRow = new St.BoxLayout({
      style_class: "gtime-picker-row",
      x_expand: true,
      x_align: Clutter.ActorAlign.CENTER,
    });

    pickerRow.add_child(this._buildColumn("hours"));
    pickerRow.add_child(this._buildColon());
    pickerRow.add_child(this._buildColumn("minutes"));
    pickerRow.add_child(this._buildColon());
    pickerRow.add_child(this._buildColumn("seconds"));
    this._setupView.add_child(pickerRow);

    this._setupView.add_child(new St.Widget({ y_expand: true }));

    const setupActionsRow = new St.BoxLayout({
      style_class: "gtime-actions-row",
      x_align: Clutter.ActorAlign.CENTER,
    });

    this._startIcon = new St.Icon({
      icon_name: "media-playback-start-symbolic",
      icon_size: 18,
    });
    this._startButton = new St.Button({
      style_class: "gtime-play-button",
      can_focus: true,
      child: this._startIcon,
    });
    this._startButton.connect("clicked", this._toggleTimer.bind(this));

    this._resetButton = new St.Button({
      style_class: "gtime-reset-button",
      can_focus: true,
      reactive: false,
      child: new St.Icon({ icon_name: "view-refresh-symbolic", icon_size: 18 }),
    });
    this._resetButton.add_style_class_name("gtime-reset-button-disabled");
    this._resetButton.connect("clicked", this._resetTimer.bind(this));

    setupActionsRow.add_child(this._startButton);
    setupActionsRow.add_child(this._resetButton);
    this._setupView.add_child(setupActionsRow);

    // =========================================================================
    // 2. ACTIVE RUNNING/PAUSED VIEW (Circular Dial with Time & Controls Inside)
    // =========================================================================
    this._runningView = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "gtime-circle-wrapper",
      visible: false,
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

    this._circleTimeLabel = new St.Label({
      text: "00:00",
      style_class: "gtime-circle-time-label",
      x_align: Clutter.ActorAlign.CENTER,
    });

    this._circleSubtitleLabel = new St.Label({
      text: "",
      style_class: "gtime-circle-subtitle",
      x_align: Clutter.ActorAlign.CENTER,
    });

    const circleActionsRow = new St.BoxLayout({
      style_class: "gtime-circle-actions-row",
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });

    this._circlePauseIcon = new St.Icon({
      icon_name: "media-playback-pause-symbolic",
      icon_size: 18,
    });
    this._circlePauseButton = new St.Button({
      style_class: "gtime-play-button gtime-play-button-paused",
      can_focus: true,
      y_align: Clutter.ActorAlign.CENTER,
      child: this._circlePauseIcon,
    });
    this._circlePauseButton.connect("clicked", this._toggleTimer.bind(this));

    this._circleResetButton = new St.Button({
      style_class: "gtime-reset-button",
      can_focus: true,
      y_align: Clutter.ActorAlign.CENTER,
      child: new St.Icon({ icon_name: "view-refresh-symbolic", icon_size: 18 }),
    });
    this._circleResetButton.connect("clicked", this._resetTimer.bind(this));

    circleActionsRow.add_child(this._circlePauseButton);
    circleActionsRow.add_child(this._circleResetButton);

    innerContent.add_child(this._circleTimeLabel);
    innerContent.add_child(this._circleSubtitleLabel);
    innerContent.add_child(circleActionsRow);

    dialOverlay.add_child(this._circleCanvas);
    dialOverlay.add_child(innerContent);
    this._runningView.add_child(dialOverlay);

    container.add_child(this._setupView);
    container.add_child(this._runningView);

    return container;
  }

  _drawCircle(area) {
    const cr = area.get_context();
    const [width, height] = area.get_surface_size();
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(cx, cy) - STROKE_WIDTH - 4;

    cr.setOperator(2);

    // 1. Subtle inner glass fill
    cr.arc(cx, cy, radius - STROKE_WIDTH / 2, 0, 2 * Math.PI);
    cr.setSourceRGBA(1, 1, 1, 0.03);
    cr.fill();

    // 2. Background circular track
    cr.setLineWidth(STROKE_WIDTH);
    cr.arc(cx, cy, radius, 0, 2 * Math.PI);
    cr.setSourceRGBA(1, 1, 1, 0.1);
    cr.stroke();

    // 3. Smooth sub-second depleting progress arc
    const totalMs =
      Math.max(1, this._lastDurationSeconds || this.remainingSeconds) * 1000;
    let remainingMs = this._pausedRemainingMs || this.remainingSeconds * 1000;
    if (this.timerId && this._endTimeMs) {
      const nowMs = GLib.get_real_time() / 1000;
      remainingMs = Math.max(0, this._endTimeMs - nowMs);
    }
    const ratio = Math.max(0, Math.min(1, remainingMs / totalMs));

    if (ratio > 0) {
      const startAngle = -Math.PI / 2;
      const endAngle = startAngle + ratio * 2 * Math.PI;

      const alpha = this.timerId ? 1.0 : 0.55;
      if (this.remainingSeconds <= CRITICAL_SECONDS_THRESHOLD) {
        cr.setSourceRGBA(1.0, 0.47, 0.47, alpha); // #ff7878
      } else if (this.remainingSeconds <= WARNING_SECONDS_THRESHOLD) {
        cr.setSourceRGBA(0.965, 0.827, 0.176, alpha); // #f6d32d
      } else {
        cr.setSourceRGBA(0.208, 0.518, 0.894, alpha); // #3584e4
      }
      cr.setLineCap(1);
      cr.setLineWidth(STROKE_WIDTH);
      cr.arc(cx, cy, radius, startAngle, endAngle);
      cr.stroke();
    }

    cr.$dispose();
  }

  _formatDurationText(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const pad = (n) => `${n}`.padStart(2, "0");
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  _buildColon() {
    return new St.Label({
      text: ":",
      style_class: "gtime-colon",
      y_align: Clutter.ActorAlign.CENTER,
    });
  }

  _buildColumn(type) {
    const column = new St.BoxLayout({
      vertical: true,
      style_class: "gtime-time-column",
      x_expand: false,
      y_align: Clutter.ActorAlign.CENTER,
      reactive: true,
    });

    column.connect("scroll-event", (_actor, event) => {
      if (this.remainingSeconds > 0) return Clutter.EVENT_PROPAGATE;
      const direction = event.get_scroll_direction();
      if (direction === Clutter.ScrollDirection.UP) {
        this._setActiveColumn(type);
        this._adjust(type, 1);
        return Clutter.EVENT_STOP;
      } else if (direction === Clutter.ScrollDirection.DOWN) {
        this._setActiveColumn(type);
        this._adjust(type, -1);
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });

    const plusButton = new St.Button({
      label: "+",
      style_class: "gtime-step-button gtime-step-button-top",
      can_focus: true,
    });
    plusButton.connect("clicked", () => {
      this._setActiveColumn(type);
      this._adjust(type, 1);
    });
    this._registerEditableButton(plusButton);

    const valueEntry = new St.Entry({
      text: "00",
      style_class: "gtime-value-entry",
      can_focus: true,
      x_expand: true,
      y_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    });
    valueEntry.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
    valueEntry.clutter_text.set_y_align(Clutter.ActorAlign.CENTER);
    valueEntry.connect("key-focus-in", () => {
      this._setActiveColumn(type);
      return Clutter.EVENT_PROPAGATE;
    });
    valueEntry.connect("key-focus-out", () => {
      this._setActiveColumn(null);
      this._renderTime();
      return Clutter.EVENT_PROPAGATE;
    });
    valueEntry.clutter_text.connect("activate", () => {
      this._renderTime();
    });
    valueEntry.clutter_text.connect("text-changed", () => {
      this._onValueEntryChanged(type, valueEntry);
    });
    valueEntry.clutter_text.connect("key-press-event", (_actor, event) => {
      return this._onValueEntryKeyPress(type, event);
    });
    this._registerEditableEntry(valueEntry);

    const minusButton = new St.Button({
      label: "-",
      style_class: "gtime-step-button gtime-step-button-bottom",
      can_focus: true,
    });
    minusButton.connect("clicked", () => {
      this._setActiveColumn(type);
      this._adjust(type, -1);
    });
    this._registerEditableButton(minusButton);

    column.add_child(plusButton);
    column.add_child(valueEntry);
    column.add_child(minusButton);

    this._columns.set(type, column);
    this._valueLabels.set(type, valueEntry);
    return column;
  }

  _setActiveColumn(type) {
    for (const [columnType, actor] of this._columns) {
      if (columnType === type && type !== null)
        actor.add_style_class_name("gtime-time-column-active");
      else actor.remove_style_class_name("gtime-time-column-active");
    }
  }

  _adjust(type, delta) {
    if (this.remainingSeconds > 0) return;

    const max = type === "hours" ? MAX_HOURS : MAX_MINUTES_OR_SECONDS;
    let nextValue = this.time[type] + delta;

    if (nextValue > max) {
      nextValue = 0;
    } else if (nextValue < 0) {
      nextValue = max;
    }

    this.time[type] = nextValue;
    if (this.triggered) {
      this.triggered = false;
      this._indicator.updatePanelFromMode();
    }
    this._renderTime();
    this._indicator.queueSave();
  }

  _setTime(hours, minutes, seconds) {
    if (this.remainingSeconds > 0) return;

    this.time.hours = Math.max(0, Math.min(MAX_HOURS, hours));
    this.time.minutes = Math.max(0, Math.min(MAX_MINUTES_OR_SECONDS, minutes));
    this.time.seconds = Math.max(0, Math.min(MAX_MINUTES_OR_SECONDS, seconds));

    if (this.triggered) {
      this.triggered = false;
      this._indicator.updatePanelFromMode();
    }
    this._renderTime();
    this._indicator.queueSave();
  }

  _renderTime() {
    const hStr = `${this.time.hours}`.padStart(2, "0");
    const mStr = `${this.time.minutes}`.padStart(2, "0");
    const sStr = `${this.time.seconds}`.padStart(2, "0");

    this._isSyncingEntries = true;
    this._valueLabels.get("hours").set_text(hStr);
    this._valueLabels.get("minutes").set_text(mStr);
    this._valueLabels.get("seconds").set_text(sStr);
    this._isSyncingEntries = false;

    if (this._circleTimeLabel) {
      if (this.time.hours > 0) {
        this._circleTimeLabel.set_text(`${hStr}:${mStr}:${sStr}`);
        this._circleTimeLabel.add_style_class_name(
          "gtime-circle-time-label-hours",
        );
      } else {
        this._circleTimeLabel.set_text(`${mStr}:${sStr}`);
        this._circleTimeLabel.remove_style_class_name(
          "gtime-circle-time-label-hours",
        );
      }
    }

    if (this._circleSubtitleLabel) {
      const total = this._lastDurationSeconds || this.remainingSeconds;
      this._circleSubtitleLabel.set_text(
        total > 0 ? `${_("Total")} ${this._formatDurationText(total)}` : "",
      );
    }

    this._updateStartButtonState();
    this._updateActiveView();
  }

  _updateActiveView() {
    const isActive = this.timerId !== null || this.remainingSeconds > 0;
    if (this._setupView && this._runningView) {
      this._setupView.visible = !isActive;
      this._runningView.visible = isActive;
    }
    if (isActive && this._circleCanvas) {
      this._circleCanvas.queue_repaint();
    }
  }

  _hasConfiguredTime() {
    return (
      this.time.hours > 0 || this.time.minutes > 0 || this.time.seconds > 0
    );
  }

  _updateStartButtonState() {
    const canStart =
      this.timerId || this.remainingSeconds > 0 || this._hasConfiguredTime();
    const canReset = this.remainingSeconds > 0 || this._hasConfiguredTime();

    this._startButton.reactive = Boolean(canStart);
    this._startButton.can_focus = Boolean(canStart);

    if (canStart)
      this._startButton.remove_style_class_name("gtime-play-button-disabled");
    else this._startButton.add_style_class_name("gtime-play-button-disabled");

    if (this._resetButton) {
      this._resetButton.reactive = Boolean(canReset);
      this._resetButton.can_focus = Boolean(canReset);
      if (canReset) {
        this._resetButton.remove_style_class_name(
          "gtime-reset-button-disabled",
        );
      } else {
        this._resetButton.add_style_class_name("gtime-reset-button-disabled");
      }
    }
  }

  _onValueEntryChanged(type, entry) {
    if (this.remainingSeconds > 0 || this._isSyncingEntries) return;

    const rawValue = entry.get_text();
    const maxVal = type === "hours" ? MAX_HOURS : MAX_MINUTES_OR_SECONDS;
    let digitsOnly = rawValue.replace(/\D/g, "").slice(-2);

    if (digitsOnly.length > 0) {
      const parsed = Number.parseInt(digitsOnly, 10);
      if (parsed > maxVal) {
        digitsOnly = `${maxVal}`;
      }
    }

    if (digitsOnly !== rawValue) {
      this._isSyncingEntries = true;
      entry.set_text(digitsOnly);
      this._isSyncingEntries = false;
    }

    this.time[type] =
      digitsOnly.length === 0 ? 0 : Number.parseInt(digitsOnly, 10);
    if (this.triggered) {
      this.triggered = false;
      this._indicator.updatePanelFromMode();
    }
    this._updateStartButtonState();
    this._indicator.queueSave();
  }

  _onValueEntryKeyPress(type, event) {
    if (this.remainingSeconds > 0) return Clutter.EVENT_PROPAGATE;

    const key = event.get_key_symbol();
    if (key === Clutter.KEY_Up) {
      this._setActiveColumn(type);
      this._adjust(type, 1);
      this._focusColumnEntry(type);
      return Clutter.EVENT_STOP;
    }

    if (key === Clutter.KEY_Down) {
      this._setActiveColumn(type);
      this._adjust(type, -1);
      this._focusColumnEntry(type);
      return Clutter.EVENT_STOP;
    }

    if (
      key === Clutter.KEY_Tab ||
      key === Clutter.KEY_KP_Tab ||
      key === Clutter.KEY_ISO_Left_Tab
    ) {
      const state = event.get_state();
      const isShiftTab =
        key === Clutter.KEY_ISO_Left_Tab ||
        Boolean(state & Clutter.ModifierType.SHIFT_MASK);
      this._focusAdjacentColumn(type, isShiftTab ? -1 : 1);
      return Clutter.EVENT_STOP;
    }

    return Clutter.EVENT_PROPAGATE;
  }

  _focusAdjacentColumn(type, step) {
    const currentIndex = TIME_PARTS.indexOf(type);
    if (currentIndex < 0) return;
    const nextIndex =
      (currentIndex + step + TIME_PARTS.length) % TIME_PARTS.length;
    this._focusColumnEntry(TIME_PARTS[nextIndex]);
  }

  _focusColumnEntry(type) {
    const entry = this._valueLabels.get(type);
    if (!entry) return;
    entry.grab_key_focus();
    this._setActiveColumn(type);
  }

  acknowledgeTriggered() {
    this.triggered = false;
    if (this._autoDismissId) {
      GLib.source_remove(this._autoDismissId);
      this._autoDismissId = null;
    }
  }

  _setActionButtonsState(isRunning) {
    const iconName = isRunning
      ? "media-playback-pause-symbolic"
      : "media-playback-start-symbolic";

    if (this._startIcon) this._startIcon.icon_name = iconName;
    if (this._circlePauseIcon) this._circlePauseIcon.icon_name = iconName;

    if (isRunning) {
      this._startButton.add_style_class_name("gtime-play-button-paused");
      this._circlePauseButton.add_style_class_name("gtime-play-button-paused");
    } else {
      this._startButton.remove_style_class_name("gtime-play-button-paused");
      this._circlePauseButton.remove_style_class_name(
        "gtime-play-button-paused",
      );
    }
  }

  _toggleTimer() {
    const nowMs = GLib.get_real_time() / 1000;
    if (this.timerId) {
      if (this._endTimeMs) {
        this._pausedRemainingMs = Math.max(0, this._endTimeMs - nowMs);
        this.remainingSeconds = Math.ceil(this._pausedRemainingMs / 1000);
      }
      this.endTime = null;
      this._endTimeMs = null;
      this.stop();

      if (this.remainingSeconds <= 0) {
        this._finishTimer();
        return;
      }

      this._setActionButtonsState(false);
      this._syncTimeFromRemaining();
      this._indicator.updatePanelFromMode();
    } else {
      if (this.remainingSeconds === 0) {
        this.remainingSeconds =
          this.time.hours * 3600 + this.time.minutes * 60 + this.time.seconds;
        this._pausedRemainingMs = this.remainingSeconds * 1000;
        if (this.remainingSeconds > 0) {
          this._lastDurationSeconds = this.remainingSeconds;
        }
      }

      if (this.remainingSeconds > 0) {
        const durationMs =
          this._pausedRemainingMs > 0
            ? this._pausedRemainingMs
            : this.remainingSeconds * 1000;
        this._endTimeMs = nowMs + durationMs;
        this.endTime = Math.round(this._endTimeMs / 1000);
        this.acknowledgeTriggered();
        this._setActionButtonsState(true);
        this._setEditingEnabled(false);
        this._syncTimeFromRemaining();
        this._indicator.updatePanelFromMode();

        this.timerId = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          1000,
          this._tick.bind(this),
        );
        GLib.Source.set_name_by_id(this.timerId, "[g-time] countdown");

        this._animTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
          if (this._circleCanvas && this._indicator.menu.isOpen) {
            this._circleCanvas.queue_repaint();
          }
          return GLib.SOURCE_CONTINUE;
        });
        GLib.Source.set_name_by_id(
          this._animTimerId,
          "[g-time] countdown-anim",
        );
      }
    }

    this._updateStartButtonState();
    this._updateActiveView();
    this._indicator.queueSave();
  }

  _tick() {
    if (this._endTimeMs) {
      const nowMs = GLib.get_real_time() / 1000;
      this.remainingSeconds = Math.max(
        0,
        Math.round((this._endTimeMs - nowMs) / 1000),
      );
    } else {
      this.remainingSeconds = Math.max(0, this.remainingSeconds - 1);
    }
    this._syncTimeFromRemaining();
    this._indicator.updatePanelFromMode();

    if (this.remainingSeconds <= 0) {
      this._finishTimer();
      return GLib.SOURCE_REMOVE;
    }

    return GLib.SOURCE_CONTINUE;
  }

  _startWithDuration(totalSeconds) {
    this.stop();
    this.triggered = false;
    this._lastDurationSeconds = totalSeconds;
    this.remainingSeconds = totalSeconds;
    this._syncTimeFromRemaining();
    this._toggleTimer();
  }

  _finishTimer() {
    const completedDuration = this._lastDurationSeconds;
    this.endTime = null;
    this._endTimeMs = null;
    this._resetTimer();
    this.triggered = true;
    this._indicator.updatePanelFromMode();
    this._indicator.queueSave();

    try {
      const source = MessageTray.getSystemNotifyingSource();
      const notification = new MessageTray.Notification({
        source,
        title: _("Timer Complete"),
        body: _("Your time is up!"),
        isTransient: false,
      });

      notification.addAction(_("+1m"), () => {
        this._startWithDuration(60);
      });

      if (completedDuration > 0) {
        notification.addAction(_("Repeat"), () => {
          this._startWithDuration(completedDuration);
        });
      }

      source.addNotification(notification);
    } catch (e) {
      Main.notify(_("Timer Complete"), _("Your time is up!"));
    }

    try {
      global.display
        .get_sound_player()
        .play_from_theme("complete", "Timer Done", null);
    } catch (e) {
      console.warn("[g-time] Failed to play sound", e);
    }

    if (this._autoDismissId) {
      GLib.source_remove(this._autoDismissId);
    }
    this._autoDismissId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      15,
      () => {
        this._autoDismissId = null;
        if (this.triggered) {
          this.triggered = false;
          this._indicator.updatePanelFromMode();
          this._indicator.queueSave();
        }
        return GLib.SOURCE_REMOVE;
      },
    );
    GLib.Source.set_name_by_id(this._autoDismissId, "[g-time] auto-dismiss");
  }

  _resetTimer() {
    this.stop();
    this.remainingSeconds = 0;
    this._pausedRemainingMs = 0;
    this.endTime = null;
    this._endTimeMs = null;
    this.time = { hours: 0, minutes: 0, seconds: 0 };
    this.triggered = false;
    this._setActionButtonsState(false);
    this._setEditingEnabled(true);
    this._renderTime();
    this._indicator.updatePanelFromMode();
    this._indicator.queueSave();
  }

  _syncTimeFromRemaining() {
    this.time.hours = Math.floor(this.remainingSeconds / 3600);
    this.time.minutes = Math.floor((this.remainingSeconds % 3600) / 60);
    this.time.seconds = this.remainingSeconds % 60;
    this._renderTime();
  }

  _registerEditableButton(button) {
    this._editableButtons.push(button);
  }

  _registerEditableEntry(entry) {
    this._editableEntries.push(entry);
  }

  _setEditingEnabled(enabled) {
    for (const button of this._editableButtons) {
      button.reactive = enabled;
      button.can_focus = enabled;
    }

    for (const entry of this._editableEntries) {
      entry.reactive = enabled;
      entry.can_focus = enabled;
      entry.clutter_text.editable = enabled;
      entry.clutter_text.set_cursor_visible(enabled);
    }

    this._setActiveColumn(null);
  }
}
