import GLib from "gi://GLib";
import St from "gi://St";
import Clutter from "gi://Clutter";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";

import { MAX_HOURS, MAX_MINUTES_OR_SECONDS, TIME_PARTS } from "./constants.js";

export class Timer {
  constructor(indicator) {
    this._indicator = indicator;
    this.time = { hours: 0, minutes: 0, seconds: 0 };
    this.timerId = null;
    this.remainingSeconds = 0;
    this.endTime = null;
    this.triggered = false;

    this._columns = new Map();
    this._valueLabels = new Map();
    this._editableButtons = [];
    this._editableEntries = [];
    this._isSyncingEntries = false;
    this._lastQuickButton = null;

    this.container = this._buildUi();
  }

  loadState(state) {
    const now = GLib.DateTime.new_now_local().to_unix();
    if (state.time) this.time = state.time;
    if (state.timerTriggered) this.triggered = state.timerTriggered;
    if (state.endTime) {
      this.remainingSeconds = Math.max(0, state.endTime - now);
      if (this.remainingSeconds > 0) this._toggleTimer();
      else {
        this.remainingSeconds = 0;
        this._finishTimer();
      }
    } else if (state.remainingSeconds) {
      this.remainingSeconds = state.remainingSeconds;
    }
    this._renderTime();
    this._updateStartButtonState();
  }

  getState() {
    const now = GLib.DateTime.new_now_local().to_unix();
    return {
      time: this.time,
      remainingSeconds: this.remainingSeconds,
      endTime: this.timerId ? now + this.remainingSeconds : null,
      timerTriggered: this.triggered,
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

    // Allow clicking the background to unfocus text entries
    container.reactive = true;
    container.connect("button-press-event", () => {
      container.grab_key_focus();
      this._setActiveColumn(null);
      return Clutter.EVENT_PROPAGATE;
    });

    container.add_child(
      new St.Label({
        text: _("Quick Start"),
        style_class: "gtime-section-title",
        x_align: 0.5,
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

    container.add_child(quickGrid);

    container.add_child(
      new St.Label({
        text: _("Set Timer"),
        style_class: "gtime-section-title gtime-section-title-spaced",
        x_align: 0.5,
        x_expand: true,
      }),
    );

    const pickerRow = new St.BoxLayout({
      style_class: "gtime-picker-row",
      x_expand: true,
    });

    pickerRow.add_child(this._buildColumn("hours"));
    pickerRow.add_child(this._buildColon());
    pickerRow.add_child(this._buildColumn("minutes"));
    pickerRow.add_child(this._buildColon());
    pickerRow.add_child(this._buildColumn("seconds"));

    container.add_child(pickerRow);

    container.add_child(new St.Widget({ y_expand: true }));

    const actionsRow = new St.BoxLayout({
      style_class: "gtime-actions-row",
      x_align: 2,
    });

    this._startButton = new St.Button({
      label: _("Start"),
      style_class: "gtime-start-button",
      can_focus: true,
    });
    this._startButton.connect("clicked", this._toggleTimer.bind(this));

    this._resetButton = new St.Button({
      style_class: "gtime-reset-button",
      can_focus: true,
      reactive: false,
      child: new St.Icon({ icon_name: "view-refresh-symbolic", icon_size: 16 }),
    });
    this._resetButton.add_style_class_name("gtime-reset-button-disabled");
    this._resetButton.connect("clicked", this._resetTimer.bind(this));

    actionsRow.add_child(this._startButton);
    actionsRow.add_child(this._resetButton);
    container.add_child(actionsRow);

    return container;
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
      x_expand: true,
      y_align: 0.5,
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
    valueEntry.clutter_text.set_max_length(2);
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

    this._lastQuickButton = null;

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
    this._isSyncingEntries = true;
    this._valueLabels
      .get("hours")
      .set_text(`${this.time.hours}`.padStart(2, "0"));
    this._valueLabels
      .get("minutes")
      .set_text(`${this.time.minutes}`.padStart(2, "0"));
    this._valueLabels
      .get("seconds")
      .set_text(`${this.time.seconds}`.padStart(2, "0"));
    this._isSyncingEntries = false;
    this._updateStartButtonState();
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
      this._startButton.remove_style_class_name("gtime-start-button-disabled");
    else this._startButton.add_style_class_name("gtime-start-button-disabled");

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

    this._lastQuickButton = null;

    const rawValue = entry.get_text();
    const digitsOnly = rawValue.replace(/\D/g, "").slice(0, 2);

    if (digitsOnly !== rawValue) {
      entry.set_text(digitsOnly);
      return;
    }

    this.time[type] =
      digitsOnly.length === 0
        ? 0
        : Math.min(MAX_HOURS, Number.parseInt(digitsOnly, 10));

    this._normalizeTime();
    if (this.triggered) {
      this.triggered = false;
      this._indicator.updatePanelFromMode();
    }
    this._updateStartButtonState();
    this._indicator.queueSave();
  }

  _normalizeTime() {
    const maxTotalSeconds =
      MAX_HOURS * 3600 + MAX_MINUTES_OR_SECONDS * 60 + MAX_MINUTES_OR_SECONDS;

    let totalSeconds =
      this.time.hours * 3600 + this.time.minutes * 60 + this.time.seconds;

    totalSeconds = Math.max(0, Math.min(maxTotalSeconds, totalSeconds));

    this.time.hours = Math.floor(totalSeconds / 3600);
    this.time.minutes = Math.floor((totalSeconds % 3600) / 60);
    this.time.seconds = totalSeconds % 60;
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

  _toggleTimer() {
    if (this.timerId) {
      this.stop();
      this._startButton.label = _("Resume");
      this._startButton.remove_style_class_name("gtime-start-button-paused");
    } else {
      if (this.remainingSeconds === 0) {
        this.remainingSeconds =
          this.time.hours * 3600 + this.time.minutes * 60 + this.time.seconds;
      }

      if (this.remainingSeconds > 0) {
        this.triggered = false;
        this._startButton.label = _("Pause");
        this._startButton.add_style_class_name("gtime-start-button-paused");
        this._setEditingEnabled(false);
        this._indicator.updatePanelFromMode();

        this.timerId = GLib.timeout_add_seconds(
          GLib.PRIORITY_DEFAULT,
          1,
          this._tick.bind(this),
        );
        GLib.Source.set_name_by_id(this.timerId, "[g-time] countdown");
      }
    }

    this._updateStartButtonState();
    this._indicator.queueSave();
  }

  _tick() {
    this.remainingSeconds = Math.max(0, this.remainingSeconds - 1);
    this._syncTimeFromRemaining();
    this._indicator.updatePanelFromMode();

    if (this.remainingSeconds <= 0) {
      this._finishTimer();
      return GLib.SOURCE_REMOVE;
    }
    return GLib.SOURCE_CONTINUE;
  }

  _finishTimer() {
    this._resetTimer();
    this.triggered = true;
    this._indicator.updatePanelFromMode();
    this._indicator.queueSave();
    Main.notify(_("Timer Complete"), _("Your time is up!"));
    try {
      global.display
        .get_sound_player()
        .play_from_theme("complete", "Timer Done", null);
    } catch (e) {
      console.warn("[g-time] Failed to play sound", e);
    }
  }

  _resetTimer() {
    this.stop();
    this.remainingSeconds = 0;
    this.time = { hours: 0, minutes: 0, seconds: 0 };
    this.triggered = false;
    this._lastQuickButton = null;
    this._renderTime();

    this._startButton.label = _("Start");
    this._startButton.remove_style_class_name("gtime-start-button-paused");
    this._setEditingEnabled(true);
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
