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
      super._init(0.0, _("g-time Indicator"));
      this.add_style_class_name("gtime-panel-button");

      this._storage = new TimeStorage();
      this._currentTab = "timer";

      this._timer = new Timer(this);
      this._stopwatch = new Stopwatch(this);
      this._reminder = new Reminder(this);

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
      this._loadState();

      this.menu.connect("open-state-changed", (menu, isOpen) => {
        if (isOpen) {
          let changed = false;

          if (this._timer.triggered) {
            this._timer.triggered = false;
            changed = true;
          }

          if (changed) {
            this.updatePanelFromMode();
            this.queueSave();
          }
        }
      });
    }

    queueSave() {
      if (this._saveTimeoutId) {
        GLib.source_remove(this._saveTimeoutId);
      }
      this._saveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        this._saveTimeoutId = null;
        this._saveStateAsync();
        return GLib.SOURCE_REMOVE;
      });
    }

    async _saveStateAsync() {
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
      if (!state) return;

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
      container.set_height(430);
      container.set_width(380);

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
      this.remove_style_class_name("gtime-panel-warning");
      this.remove_style_class_name("gtime-panel-critical");
      this.remove_style_class_name("gtime-panel-critical-blink");
    }

    updatePanelFromMode() {
      this._clearPanelAlertState();
      this._panelLabel.visible = false;
      this._panelIcon.visible = true;

      let activeCount = 0;

      if (this._timer.timerId || this._timer.remainingSeconds > 0) {
        activeCount++;
        this._panelLabel.visible = true;
        this._panelIcon.visible = false;

        const h = `${this._timer.time.hours}`.padStart(2, "0");
        const m = `${this._timer.time.minutes}`.padStart(2, "0");
        const s = `${this._timer.time.seconds}`.padStart(2, "0");
        this._panelLabel.text =
          this._timer.time.hours > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;

        if (
          this._timer.remainingSeconds > 0 &&
          this._timer.remainingSeconds <= CRITICAL_SECONDS_THRESHOLD
        ) {
          this.add_style_class_name("gtime-panel-critical");
          if (this._timer.timerId && this._timer.remainingSeconds % 2 === 0)
            this.add_style_class_name("gtime-panel-critical-blink");
        } else if (
          this._timer.remainingSeconds > 0 &&
          this._timer.remainingSeconds <= WARNING_SECONDS_THRESHOLD
        ) {
          this.add_style_class_name("gtime-panel-warning");
        }
      }

      if (this._stopwatch.timerId || this._stopwatch.seconds > 0) {
        activeCount++;
        if (activeCount === 1) {
          this._panelLabel.visible = true;
          this._panelIcon.visible = false;
          const m = Math.floor((this._stopwatch.seconds % 3600) / 60);
          const s = this._stopwatch.seconds % 60;
          this._panelLabel.text = `⏱ ${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
        }
      }

      if (activeCount > 1) {
        this._panelLabel.text = `[${activeCount}] \u23F2`;
        this._panelIcon.visible = false;
        this._panelLabel.visible = true;
      }

      const reminderTriggered = this._reminder.reminders.some(
        (rm) => rm.triggered,
      );
      const timerTriggered = this._timer.triggered;
      const hasTriggered = reminderTriggered || timerTriggered;

      if (hasTriggered) {
        if (!this.has_style_class_name("gtime-panel-critical")) {
          this.add_style_class_name("gtime-panel-warning");
        }
        if (activeCount === 0) {
          this._panelLabel.text = `\u2022`;
          this._panelLabel.visible = true;
          this._panelIcon.icon_name =
            reminderTriggered && !timerTriggered
              ? "preferences-system-notifications-symbolic"
              : "alarm-symbolic";
        } else {
          this._panelLabel.text = `\u2022 ` + this._panelLabel.text;
        }
      } else {
        this._panelIcon.icon_name = "alarm-symbolic";
      }
    }

    destroy() {
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
