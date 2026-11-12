/* indicator.js
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

import { gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import { TimeStorage } from "./storage.js";
import { Timer } from "./timer.js";
import { Stopwatch } from "./stopwatch.js";
import { Reminder } from "./reminder.js";

import {
  WARNING_SECONDS_THRESHOLD,
  CRITICAL_SECONDS_THRESHOLD,
} from "./constants.js";

export const Indicator = GObject.registerClass(
  class Indicator extends PanelMenu.Button {
    _init() {
      super._init(0.5, _("g-time Indicator"));
      this.add_style_class_name("gtime-panel-button");

      this._storage = new TimeStorage();
      this._currentTab = "timer";

      this._timer = new Timer(this);
      this._stopwatch = new Stopwatch(this);
      this._reminder = new Reminder(this);

      this._panelLayout = new St.BoxLayout({
        style_class: "gtime-panel-layout",
      });

      // 1. Timer Group
      this._timerBox = new St.BoxLayout({
        style_class: "gtime-indicator-group",
        y_align: Clutter.ActorAlign.CENTER,
        visible: false,
      });
      this._timerIcon = new St.Icon({
        icon_name: "hourglass-symbolic",
        style_class: "system-status-icon",
      });
      this._timerLabel = new St.Label({
        style_class: "gtime-panel-label",
        y_align: Clutter.ActorAlign.CENTER,
      });
      this._timerBox.add_child(this._timerIcon);
      this._timerBox.add_child(this._timerLabel);
      this._panelLayout.add_child(this._timerBox);

      // 2. Stopwatch Group
      this._stopwatchBox = new St.BoxLayout({
        style_class: "gtime-indicator-group",
        y_align: Clutter.ActorAlign.CENTER,
        visible: false,
      });
      this._stopwatchIcon = new St.Icon({
        icon_name: "timer-symbolic",
        style_class: "system-status-icon",
      });
      this._stopwatchLabel = new St.Label({
        style_class: "gtime-panel-label",
        y_align: Clutter.ActorAlign.CENTER,
      });
      this._stopwatchBox.add_child(this._stopwatchIcon);
      this._stopwatchBox.add_child(this._stopwatchLabel);
      this._panelLayout.add_child(this._stopwatchBox);

      // 3. Default/Reminder Icon
      this._defaultIcon = new St.Icon({
        icon_name: "alarm-symbolic",
        style_class: "system-status-icon",
      });
      this._panelLayout.add_child(this._defaultIcon);

      this.add_child(this._panelLayout);
      this._buildMenuUi();
      this._loadState();

      this._isDestroyed = false;

      this.connect("scroll-event", (_actor, event) => {
        const direction = event.get_scroll_direction();
        const tabs = ["timer", "stopwatch", "reminder"];
        const idx = tabs.indexOf(this._currentTab);
        if (direction === Clutter.ScrollDirection.UP) {
          this._switchTab(tabs[(idx - 1 + tabs.length) % tabs.length]);
          return Clutter.EVENT_STOP;
        } else if (direction === Clutter.ScrollDirection.DOWN) {
          this._switchTab(tabs[(idx + 1) % tabs.length]);
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
      });

      this.connect("captured-event", (_actor, event) => {
        const type = event.type();
        if (
          (type === Clutter.EventType.BUTTON_PRESS ||
            type === Clutter.EventType.BUTTON_RELEASE) &&
          (event.get_button() === Clutter.BUTTON_SECONDARY ||
            event.get_button() === Clutter.BUTTON_MIDDLE)
        ) {
          if (type === Clutter.EventType.BUTTON_PRESS) {
            this._onQuickToggle(event);
          }
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
      });

      this.menu.connect("open-state-changed", (_menu, isOpen) => {
        if (isOpen) {
          this._reminder.refreshListIfVisible();
          if (this._timer.triggered) {
            this._timer.acknowledgeTriggered();
            this.updatePanelFromMode();
            this.queueSave();
          }
        }
      });
    }

    _getTargetBoxFromEvent(event) {
      const timerVisible = this._timerBox.visible;
      const stopwatchVisible = this._stopwatchBox.visible;

      if (timerVisible && !stopwatchVisible) return "timer";
      if (stopwatchVisible && !timerVisible) return "stopwatch";
      if (!timerVisible && !stopwatchVisible) return null;

      // Both Timer and Stopwatch are visible in the top bar:
      // Determine which side of the indicator the user clicked using stage coordinates.
      const [evX] = event.get_coords();
      const [timerX] = this._timerBox.get_transformed_position();
      const [timerW] = this._timerBox.get_transformed_size();
      const [swX] = this._stopwatchBox.get_transformed_position();

      // Calculate the midpoint in the gap between the Timer box and Stopwatch box
      const splitX = (timerX + timerW + swX) / 2;
      return evX <= splitX ? "timer" : "stopwatch";
    }

    _onQuickToggle(event) {
      const targetBox = this._getTargetBoxFromEvent(event);

      // 1. If the Timer alarm is currently flashing red:
      //    - If the user clicked the Timer pill (or Stopwatch isn't visible), acknowledge the Timer alarm.
      //    - If both are visible and the user specifically right-clicked the Stopwatch pill, toggle the Stopwatch!
      if (this._timer.triggered && targetBox !== "stopwatch") {
        this._timer.acknowledgeTriggered();
        this.updatePanelFromMode();
        this.queueSave();
        return;
      }

      // 2. If both or either indicator pill is visible on the panel, toggle the exact one clicked
      if (targetBox === "timer") {
        this._timer._toggleTimer();
        return;
      }
      if (targetBox === "stopwatch") {
        this._stopwatch._toggleStopwatch();
        return;
      }

      // 3. Neither Timer nor Stopwatch is currently visible on the panel (Idle / Default Icon state):
      //    Prioritize the currently selected tab in the menu, falling back to any configured timer.
      if (this._currentTab === "stopwatch") {
        this._stopwatch._toggleStopwatch();
      } else if (this._timer._hasConfiguredTime()) {
        this._timer._toggleTimer();
      }
    }

    queueSave() {
      if (this._isDestroyed) return;
      if (this._saveTimeoutId) {
        GLib.source_remove(this._saveTimeoutId);
      }
      this._saveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        this._saveTimeoutId = null;
        this._saveStateAsync();
        return GLib.SOURCE_REMOVE;
      });
      GLib.Source.set_name_by_id(this._saveTimeoutId, "[g-time] save-state");
    }

    async _saveStateAsync() {
      if (this._isDestroyed) return;
      const state = {
        currentTab: this._currentTab,
        ...this._timer.getState(),
        ...this._stopwatch.getState(),
        ...this._reminder.getState(),
      };
      await this._storage.saveState(state);
    }

    async _loadState() {
      const state = await this._storage.readState();
      if (!state || this._isDestroyed) return;

      if (state.currentTab) {
        this._switchTab(state.currentTab);
      }
      this._timer.loadState(state);
      this._stopwatch.loadState(state);
      this._reminder.loadState(state);

      this.updatePanelFromMode();
    }

    _buildMenuUi() {
      this.menu.box.add_style_class_name("gtime-menu");

      const customItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
      });

      const container = new St.BoxLayout({
        vertical: true,
        style_class: "gtime-container",
      });

      const headerRow = new St.BoxLayout({
        style_class: "gtime-header-row",
        x_expand: true,
      });

      const sectionHeader = new St.BoxLayout({
        vertical: true,
        style_class: "gtime-section-header",
        x_expand: true,
      });

      sectionHeader.add_child(
        new St.Label({
          text: _("G-Time"),
          style_class: "gtime-section-title-start",
          x_align: Clutter.ActorAlign.START,
        }),
      );

      this._subtitleLabel = new St.Label({
        text: _("A quick and precise timer"),
        style_class: "gtime-section-subtitle",
        x_align: Clutter.ActorAlign.START,
      });
      sectionHeader.add_child(this._subtitleLabel);

      headerRow.add_child(sectionHeader);

      const tabActions = this._buildTabBar();
      headerRow.add_child(tabActions);

      container.add_child(headerRow);

      this._timerContainer = this._timer.container;
      this._stopwatchContainer = this._stopwatch.container;
      this._reminderContainer = this._reminder.container;

      this._stopwatchContainer.visible = false;
      this._reminderContainer.visible = false;

      this._contentBox = new St.BoxLayout({
        vertical: true,
        x_expand: true,
        y_expand: true,
      });
      this._contentBox.add_child(this._timerContainer);
      this._contentBox.add_child(this._stopwatchContainer);
      this._contentBox.add_child(this._reminderContainer);

      container.add_child(this._contentBox);
      customItem.add_child(container);
      this.menu.addMenuItem(customItem);
    }

    _buildTabBar() {
      this._tabBar = new St.BoxLayout({
        style_class: "gtime-tab-bar",
        y_align: Clutter.ActorAlign.CENTER,
      });

      this._tabs = {
        timer: new St.Button({
          style_class: "gtime-icon-tab gtime-icon-tab-active",
          can_focus: true,
          child: new St.Icon({
            icon_name: "hourglass-symbolic",
            icon_size: 16,
          }),
        }),
        stopwatch: new St.Button({
          style_class: "gtime-icon-tab",
          can_focus: true,
          child: new St.Icon({ icon_name: "timer-symbolic", icon_size: 16 }),
        }),
        reminder: new St.Button({
          style_class: "gtime-icon-tab",
          can_focus: true,
          child: new St.Icon({ icon_name: "alarm-symbolic", icon_size: 16 }),
        }),
      };

      for (const [id, btn] of Object.entries(this._tabs)) {
        btn.connect("clicked", () => this._switchTab(id));
        this._tabBar.add_child(btn);
      }
      return this._tabBar;
    }

    _switchTab(tabId) {
      this._currentTab = tabId;
      for (const [id, btn] of Object.entries(this._tabs)) {
        if (id === tabId) btn.add_style_class_name("gtime-icon-tab-active");
        else btn.remove_style_class_name("gtime-icon-tab-active");
      }
      this._timerContainer.visible = tabId === "timer";
      this._stopwatchContainer.visible = tabId === "stopwatch";
      this._reminderContainer.visible = tabId === "reminder";

      if (this._subtitleLabel) {
        if (tabId === "timer") {
          this._subtitleLabel.set_text(_("A quick and precise timer"));
        } else if (tabId === "stopwatch") {
          this._subtitleLabel.set_text(_("Track elapsed time"));
        } else if (tabId === "reminder") {
          this._subtitleLabel.set_text(_("Set quick alerts or reminders"));
        }
      }

      this.queueSave();
    }

    _clearPanelAlertState() {
      // Clear root classes just in case
      this.remove_style_class_name("gtime-panel-warning");
      this.remove_style_class_name("gtime-panel-critical");

      // Clear isolated classes
      this._timerBox.remove_style_class_name("gtime-timer-warning");
      this._timerBox.remove_style_class_name("gtime-timer-critical");
      this._timerBox.remove_style_class_name("gtime-timer-critical-blink");
    }

    updatePanelFromMode() {
      this._clearPanelAlertState();

      // Hide all elements by default
      this._timerBox.visible = false;
      this._stopwatchBox.visible = false;
      this._defaultIcon.visible = false;

      let activeCount = 0;

      // Handle Timer Display
      if (this._timer.timerId || this._timer.remainingSeconds > 0) {
        if (this._timer.timerId) {
          this._timerBox.remove_style_class_name("gtime-indicator-paused");
        } else {
          this._timerBox.add_style_class_name("gtime-indicator-paused");
        }
        activeCount++;
        this._timerBox.visible = true;

        const h = `${this._timer.time.hours}`.padStart(2, "0");
        const m = `${this._timer.time.minutes}`.padStart(2, "0");
        const s = `${this._timer.time.seconds}`.padStart(2, "0");
        this._timerLabel.text =
          this._timer.time.hours > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;

        if (
          this._timer.remainingSeconds > 0 &&
          this._timer.remainingSeconds <= CRITICAL_SECONDS_THRESHOLD
        ) {
          this._timerBox.add_style_class_name("gtime-timer-critical");
          if (this._timer.timerId && this._timer.remainingSeconds % 2 === 0)
            this._timerBox.add_style_class_name("gtime-timer-critical-blink");
        } else if (
          this._timer.remainingSeconds > 0 &&
          this._timer.remainingSeconds <= WARNING_SECONDS_THRESHOLD
        ) {
          this._timerBox.add_style_class_name("gtime-timer-warning");
        }
      }

      // Handle Stopwatch Display
      if (this._stopwatch.timerId || this._stopwatch.seconds > 0) {
        if (this._stopwatch.timerId) {
          this._stopwatchBox.remove_style_class_name("gtime-indicator-paused");
        } else {
          this._stopwatchBox.add_style_class_name("gtime-indicator-paused");
        }
        activeCount++;
        this._stopwatchBox.visible = true;

        const h = Math.floor(this._stopwatch.seconds / 3600);
        const m = Math.floor((this._stopwatch.seconds % 3600) / 60);
        const s = this._stopwatch.seconds % 60;

        if (h > 0) {
          this._stopwatchLabel.text = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
        } else {
          this._stopwatchLabel.text = `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
        }
      }

      // Handle Default & Triggered State
      const reminderTriggered = this._reminder.reminders.some(
        (rm) => rm.triggered,
      );
      const timerTriggered = this._timer.triggered;
      const hasTriggered = reminderTriggered || timerTriggered;

      if (hasTriggered) {
        // If timer is done, keep the timer box red until acknowledged
        if (timerTriggered) {
          this._timerBox.visible = true;
          this._timerBox.add_style_class_name("gtime-timer-critical");
        }

        // If a reminder triggered, we can color the root panel yellow as a general alert
        if (reminderTriggered) {
          this.add_style_class_name("gtime-panel-warning");
        }

        if (activeCount === 0 && !timerTriggered) {
          this._defaultIcon.visible = true;
          this._defaultIcon.icon_name =
            "preferences-system-notifications-symbolic";
        }
      } else if (activeCount === 0) {
        this._defaultIcon.visible = true;
        this._defaultIcon.icon_name = "alarm-symbolic";
      }
    }

    destroy() {
      this._isDestroyed = true;
      if (this._saveTimeoutId) {
        GLib.source_remove(this._saveTimeoutId);
        this._saveTimeoutId = null;
      }

      const state = {
        currentTab: this._currentTab,
        ...this._timer.getState(),
        ...this._stopwatch.getState(),
        ...this._reminder.getState(),
      };
      this._storage.saveStateSync(state);

      this._timer.stop();
      this._stopwatch.stop();
      this._reminder.stop();
      super.destroy();
    }
  },
);
