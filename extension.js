/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from "gi://GLib";
import GObject from "gi://GObject";
import St from "gi://St";
import Clutter from "gi://Clutter";

import {
  Extension,
  gettext as _,
} from "resource:///org/gnome/shell/extensions/extension.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

const MAX_HOURS = 99;
const MAX_MINUTES_OR_SECONDS = 59;
const TIME_PARTS = ["hours", "minutes", "seconds"];
const WARNING_SECONDS_THRESHOLD = 60;
const CRITICAL_SECONDS_THRESHOLD = 10;

const Indicator = GObject.registerClass(
  class Indicator extends PanelMenu.Button {
    _init() {
      super._init(0.0, _("g-time Indicator"));

      this._time = { hours: 0, minutes: 0, seconds: 0 };
      this._timerId = null;
      this._remainingSeconds = 0;

      this._columns = new Map();
      this._valueLabels = new Map();
      this._editableButtons = [];
      this._editableEntries = [];
      this._isSyncingEntries = false;

      this._panelLayout = new St.BoxLayout({
        style_class: "gtime-panel-layout",
      });

      this._panelIcon = new St.Icon({
        icon_name: "alarm-symbolic",
        style_class: "system-status-icon",
      });
      this._panelLayout.add_child(this._panelIcon);

      this._panelLabel = new St.Label({
        style_class: "gtime-panel-label",
        y_align: Clutter.ActorAlign.CENTER,
        visible: false,
      });
      this._panelLayout.add_child(this._panelLabel);

      this.add_child(this._panelLayout);
      this._buildMenuUi();
    }

    _buildMenuUi() {
      const customItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
        style_class: "gtime-root-item",
      });

      const container = new St.BoxLayout({
        vertical: true,
        style_class: "gtime-container",
        x_expand: true,
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
        // Keep quick presets grouped by expected usage frequency.
        [
          { label: "1 m", h: 0, m: 1, s: 0 },
          { label: "5 m", h: 0, m: 5, s: 0 },
          { label: "10 m", h: 0, m: 10, s: 0 },
          { label: "15 m", h: 0, m: 15, s: 0 },
        ],
        [
          { label: "20 m", h: 0, m: 20, s: 0 },
          { label: "30 m", h: 0, m: 30, s: 0 },
          { label: "45 m", h: 0, m: 45, s: 0 },
          { label: "1 h", h: 1, m: 0, s: 0 },
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
            this._setTime(item.h, item.m, item.s);
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

      const resetButton = new St.Button({
        style_class: "gtime-reset-button",
        can_focus: true,
        child: new St.Icon({ icon_name: "edit-undo-symbolic", icon_size: 16 }),
      });
      resetButton.connect("clicked", this._resetTimer.bind(this));

      actionsRow.add_child(this._startButton);
      actionsRow.add_child(resetButton);
      container.add_child(actionsRow);

      customItem.add_child(container);
      this.menu.addMenuItem(customItem);

      this._renderTime();
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
      });
      valueEntry.clutter_text.set_max_length(2);
      valueEntry.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
      valueEntry.connect("key-focus-in", () => {
        this._setActiveColumn(type);
        return Clutter.EVENT_PROPAGATE;
      });
      valueEntry.connect("key-focus-out", () => {
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
        if (columnType === type)
          actor.add_style_class_name("gtime-time-column-active");
        else actor.remove_style_class_name("gtime-time-column-active");
      }
    }

    _adjust(type, delta) {
      if (this._remainingSeconds > 0) return;

      const max = type === "hours" ? MAX_HOURS : MAX_MINUTES_OR_SECONDS;
      const nextValue = this._time[type] + delta;

      this._time[type] = Math.max(0, Math.min(max, nextValue));
      this._renderTime();
    }

    _setTime(hours, minutes, seconds) {
      if (this._remainingSeconds > 0) return;

      this._time.hours = Math.max(0, Math.min(MAX_HOURS, hours));
      this._time.minutes = Math.max(
        0,
        Math.min(MAX_MINUTES_OR_SECONDS, minutes),
      );
      this._time.seconds = Math.max(
        0,
        Math.min(MAX_MINUTES_OR_SECONDS, seconds),
      );
      this._renderTime();
    }

    _renderTime() {
      this._isSyncingEntries = true;
      this._valueLabels.get("hours").set_text(
        `${this._time.hours}`.padStart(2, "0"),
      );
      this._valueLabels.get("minutes").set_text(
        `${this._time.minutes}`.padStart(2, "0"),
      );
      this._valueLabels.get("seconds").set_text(
        `${this._time.seconds}`.padStart(2, "0"),
      );
      this._isSyncingEntries = false;
    }

    _onValueEntryChanged(type, entry) {
      if (this._remainingSeconds > 0 || this._isSyncingEntries) return;

      const rawValue = entry.get_text();
      const digitsOnly = rawValue.replace(/\D/g, "").slice(0, 2);

      if (digitsOnly !== rawValue) {
        entry.set_text(digitsOnly);
        return;
      }

      this._time[type] = digitsOnly.length === 0
        ? 0
        : Math.min(MAX_HOURS, Number.parseInt(digitsOnly, 10));

      this._normalizeTime();
    }

    _normalizeTime() {
      const maxTotalSeconds =
        MAX_HOURS * 3600 +
        MAX_MINUTES_OR_SECONDS * 60 +
        MAX_MINUTES_OR_SECONDS;

      let totalSeconds =
        this._time.hours * 3600 +
        this._time.minutes * 60 +
        this._time.seconds;

      totalSeconds = Math.max(0, Math.min(maxTotalSeconds, totalSeconds));

      this._time.hours = Math.floor(totalSeconds / 3600);
      this._time.minutes = Math.floor((totalSeconds % 3600) / 60);
      this._time.seconds = totalSeconds % 60;
    }

    _onValueEntryKeyPress(type, event) {
      if (this._remainingSeconds > 0) return Clutter.EVENT_PROPAGATE;

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

      const nextIndex = (currentIndex + step + TIME_PARTS.length) % TIME_PARTS.length;
      this._focusColumnEntry(TIME_PARTS[nextIndex]);
    }

    _focusColumnEntry(type) {
      const entry = this._valueLabels.get(type);
      if (!entry) return;

      entry.grab_key_focus();
      this._setActiveColumn(type);
    }

    _toggleTimer() {
      if (this._timerId) {
        // Active source means the timer is currently running, so this action pauses it.
        this._stopTimerSource();
        this._startButton.label = _("Resume");
        this._startButton.remove_style_class_name("gtime-start-button-paused");
      } else {
        if (this._remainingSeconds === 0) {
          this._remainingSeconds =
            this._time.hours * 3600 +
            this._time.minutes * 60 +
            this._time.seconds;
        }

        if (this._remainingSeconds > 0) {
          // A countdown can be resumed from its last remaining value.
          this._startButton.label = _("Pause");
          this._startButton.add_style_class_name("gtime-start-button-paused");
          this._panelLabel.visible = true;
          this._panelIcon.visible = false;
          this._setEditingEnabled(false);
          this._updatePanelLabel();
          this._updatePanelAlertState();

          this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            1,
            this._tick.bind(this),
          );
          GLib.Source.set_name_by_id(this._timerId, "[g-time] countdown");
        }
      }
    }

    _tick() {
      this._remainingSeconds = Math.max(0, this._remainingSeconds - 1);
      this._syncTimeFromRemaining();
      this._updatePanelLabel();
      this._updatePanelAlertState();

      if (this._remainingSeconds <= 0) {
        this._finishTimer();
        return GLib.SOURCE_REMOVE;
      }
      return GLib.SOURCE_CONTINUE;
    }

    _finishTimer() {
      this._resetTimer();

      Main.notify(_("Timer Complete"), _("Your time is up!"));
    }

    _resetTimer() {
      this._stopTimerSource();
      this._remainingSeconds = 0;
      this._time = { hours: 0, minutes: 0, seconds: 0 };
      this._renderTime();

      this._panelLabel.visible = false;
      this._panelIcon.visible = true;
      this._startButton.label = _("Start");
      this._startButton.remove_style_class_name("gtime-start-button-paused");
      this._setEditingEnabled(true);
      this._clearPanelAlertState();
    }

    _updatePanelLabel() {
      const h = `${this._time.hours}`.padStart(2, "0");
      const m = `${this._time.minutes}`.padStart(2, "0");
      const s = `${this._time.seconds}`.padStart(2, "0");

      this._panelLabel.text =
        this._time.hours > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
    }

    _syncTimeFromRemaining() {
      this._time.hours = Math.floor(this._remainingSeconds / 3600);
      this._time.minutes = Math.floor((this._remainingSeconds % 3600) / 60);
      this._time.seconds = this._remainingSeconds % 60;
      this._renderTime();
    }

    _clearPanelAlertState() {
      this._panelLayout.remove_style_class_name("gtime-panel-warning");
      this._panelLayout.remove_style_class_name("gtime-panel-critical");
      this._panelLayout.remove_style_class_name("gtime-panel-critical-blink");
    }

    _updatePanelAlertState() {
      this._clearPanelAlertState();

      if (this._remainingSeconds <= 0) return;

      if (this._remainingSeconds <= CRITICAL_SECONDS_THRESHOLD) {
        this._panelLayout.add_style_class_name("gtime-panel-critical");

        // Blink only while countdown is actively ticking.
        if (this._timerId && this._remainingSeconds % 2 === 0)
          this._panelLayout.add_style_class_name("gtime-panel-critical-blink");

        return;
      }

      if (this._remainingSeconds <= WARNING_SECONDS_THRESHOLD)
        this._panelLayout.add_style_class_name("gtime-panel-warning");
    }

    _stopTimerSource() {
      if (!this._timerId) return;

      GLib.source_remove(this._timerId);
      this._timerId = null;
    }

    _registerEditableButton(button) {
      this._editableButtons.push(button);
    }

    _registerEditableEntry(entry) {
      this._editableEntries.push(entry);
    }

    _setEditingEnabled(enabled) {
      // Lock picker/presets when a countdown exists so display and state stay in sync.
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

      if (enabled) {
        for (const actor of this._columns.values())
          actor.remove_style_class_name("gtime-time-column-active");
      }
    }

    destroy() {
      this._stopTimerSource();
      super.destroy();
    }
  },
);

export default class IndicatorExampleExtension extends Extension {
  enable() {
    this._indicator = new Indicator();
    Main.panel.addToStatusArea(this.uuid, this._indicator);
  }

  disable() {
    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }
  }
}
