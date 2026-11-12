import GLib from "gi://GLib";
import St from "gi://St";
import Clutter from "gi://Clutter";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as MessageTray from "resource:///org/gnome/shell/ui/messageTray.js";
import { gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";

export class Reminder {
  constructor(indicator) {
    this._indicator = indicator;
    this.reminders = [];
    this._isAddingReminder = false;
    this._editingReminderIndex = null;

    this.container = this._buildUi();

    this.timerId = null;
    this._scheduleNextCheck();
  }

  loadState(state) {
    if (state.reminders) {
      this.reminders = state.reminders;
      this._sortReminders();
      this._scheduleNextCheck();
    }
    if (this._renderReminderView) this._renderReminderView();
  }

  getState() {
    return {
      reminders: this.reminders,
    };
  }

  stop() {
    if (this.timerId) {
      GLib.source_remove(this.timerId);
      this.timerId = null;
    }
    if (this._focusIdleId) {
      GLib.source_remove(this._focusIdleId);
      this._focusIdleId = null;
    }
  }

  _scheduleNextCheck() {
    if (this.timerId) {
      GLib.source_remove(this.timerId);
      this.timerId = null;
    }

    let now = GLib.DateTime.new_now_local();
    let minDiffSeconds = null;

    for (let rm of this.reminders) {
      if (!rm.triggered && rm.date && rm.time) {
        let parts = rm.date.split("-");
        let tparts = rm.time.split(":");
        if (parts.length === 3 && tparts.length === 2) {
          let rd = GLib.DateTime.new_local(
            parseInt(parts[0], 10),
            parseInt(parts[1], 10),
            parseInt(parts[2], 10),
            parseInt(tparts[0], 10),
            parseInt(tparts[1], 10),
            0,
          );
          if (rd) {
            let diff = Math.floor(rd.difference(now) / 1000000);
            if (diff <= 0) {
              minDiffSeconds = 1;
            } else if (minDiffSeconds === null || diff < minDiffSeconds) {
              minDiffSeconds = diff;
            }
          }
        }
      }
    }

    if (minDiffSeconds !== null) {
      let delay = Math.max(1, Math.min(minDiffSeconds, 86400));
      this.timerId = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        delay,
        this._checkReminders.bind(this),
      );
      GLib.Source.set_name_by_id(this.timerId, "[g-time] reminder-check");
    }
  }

  _buildUi() {
    this._reminderContainerBox = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      y_expand: true,
    });

    this._reminderViews = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      y_expand: true,
    });
    this._reminderContainerBox.add_child(this._reminderViews);

    this._isAddingReminder = false;
    if (this._renderReminderView) this._renderReminderView();

    return this._reminderContainerBox;
  }

  refreshListIfVisible() {
    if (!this._isAddingReminder) {
      this._renderReminderView();
    }
  }

  _formatReminderSubtitle(rm) {
    const timeStr = rm.displayTime || rm.time;
    if (rm.triggered) {
      return `${_("Triggered")}  \u2022  ${timeStr}`;
    }

    const now = GLib.DateTime.new_now_local();
    const todayStr = now.format("%Y-%m-%d");
    const tomorrowStr = now.add_days(1).format("%Y-%m-%d");

    let dateLabel = rm.date;
    if (rm.date === todayStr) {
      dateLabel = _("Today");
    } else if (rm.date === tomorrowStr) {
      dateLabel = _("Tomorrow");
    }

    let relativeStr = "";
    if (rm.date && rm.time) {
      const parts = rm.date.split("-");
      const tparts = rm.time.split(":");
      if (parts.length === 3 && tparts.length === 2) {
        const rd = GLib.DateTime.new_local(
          parseInt(parts[0], 10),
          parseInt(parts[1], 10),
          parseInt(parts[2], 10),
          parseInt(tparts[0], 10),
          parseInt(tparts[1], 10),
          0,
        );
        if (rd) {
          const diffMins = Math.ceil(rd.difference(now) / 60000000);
          if (diffMins > 0 && diffMins < 60) {
            relativeStr = ` (${_("in")} ${diffMins}m)`;
          } else if (diffMins >= 60 && diffMins < 1440) {
            const h = Math.floor(diffMins / 60);
            const m = diffMins % 60;
            relativeStr =
              m > 0 ? ` (${_("in")} ${h}h ${m}m)` : ` (${_("in")} ${h}h)`;
          } else if (diffMins >= 1440) {
            const d = Math.round(diffMins / 1440);
            relativeStr = ` (${_("in")} ${d}d)`;
          }
        }
      }
    }

    return `${timeStr}  \u2022  ${dateLabel}${relativeStr}`;
  }

  _renderReminderView() {
    if (!this._reminderViews) return;
    this._reminderViews.destroy_all_children();

    if (this._isAddingReminder) {
      this._buildReminderAddForm();
    } else {
      this._buildReminderList();
    }
  }

  _buildReminderList() {
    const listContainer = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      y_expand: true,
      style_class: "gtime-reminder-list-container",
    });

    const scroll = new St.ScrollView({
      style_class: "vfade",
      x_expand: true,
      y_expand: true,
      enable_mouse_scrolling: true,
    });
    scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.EXTERNAL);

    const content = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      style_class: "gtime-reminder-list",
    });
    if (scroll.set_child) {
      scroll.set_child(content);
    } else {
      scroll.add_child(content);
    }

    if (!this.reminders || this.reminders.length === 0) {
      const emptyLabel = new St.Label({
        text: _("No reminders set."),
        style_class: "gtime-reminder-empty",
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        margin_top: 20,
      });
      content.add_child(emptyLabel);
    } else {
      for (let i = 0; i < this.reminders.length; i++) {
        let rm = this.reminders[i];
        let card = new St.BoxLayout({
          vertical: true,
          style_class: rm.triggered
            ? "gtime-reminder-card-triggered"
            : "gtime-reminder-card",
          x_expand: true,
          reactive: true,
          track_hover: true,
        });

        let header = new St.BoxLayout({
          x_expand: true,
          y_align: Clutter.ActorAlign.CENTER,
        });

        let titleBox = new St.BoxLayout({ vertical: true, x_expand: true });
        let titleText = rm.title || _("Reminder");
        let title = new St.Label({
          text: titleText,
          style_class: "gtime-reminder-title",
        });
        let timeInfo = new St.Label({
          text: this._formatReminderSubtitle(rm),
          style_class: "gtime-reminder-subtitle",
          margin_top: 2,
        });
        titleBox.add_child(title);
        titleBox.add_child(timeInfo);

        let actionsBox = new St.BoxLayout({
          y_align: Clutter.ActorAlign.CENTER,
        });

        let editBtn = new St.Button({
          style_class: "gtime-rem-action-btn",
          child: new St.Icon({
            icon_name: "document-edit-symbolic",
            icon_size: 14,
          }),
          can_focus: true,
          y_align: Clutter.ActorAlign.CENTER,
        });
        editBtn.set_opacity(0);
        editBtn.connect("clicked", () => {
          this._editingReminderIndex = i;
          this._isAddingReminder = true;
          this._renderReminderView();
        });

        let restartBtn = new St.Button({
          style_class: "gtime-rem-action-btn",
          child: new St.Icon({
            icon_name: "view-refresh-symbolic",
            icon_size: 14,
          }),
          can_focus: true,
          y_align: Clutter.ActorAlign.CENTER,
        });
        restartBtn.set_opacity(0);
        restartBtn.connect("clicked", () => {
          // 1. Reconstruct the exact original target date and time
          let parts = rm.date.split("-");
          let tparts = rm.time.split(":");
          let originalDt = GLib.DateTime.new_local(
            parseInt(parts[0], 10),
            parseInt(parts[1], 10),
            parseInt(parts[2], 10),
            parseInt(tparts[0], 10),
            parseInt(tparts[1], 10),
            0,
          );

          // 2. Calculate the original interval in days, with a 1-day minimum
          let originalMins = rm.durationMins || 1440;
          let intervalDays = Math.round(originalMins / 1440);

          // If it was a short-term reminder (e.g., set for later today),
          // we default to restarting it for tomorrow (1 day).
          if (intervalDays < 1) {
            intervalDays = 1;
          }

          let now = GLib.DateTime.new_now_local();
          let nextDt = originalDt;

          // 3. Roll forward by the calculated interval until it's in the future
          while (nextDt.compare(now) <= 0) {
            nextDt = nextDt.add_days(intervalDays);
          }

          // 4. Update the reminder object
          rm.triggered = false;
          rm.date = nextDt.format("%Y-%m-%d");
          // rm.time stays the same, preserving the exact HH:MM
          rm.displayTime = nextDt.format("%I:%M %p").replace(/^0/, "");

          this._scheduleNextCheck();
          this._indicator.queueSave();
          this._indicator.updatePanelFromMode();
          this._renderReminderView();
        });

        let delBtn = new St.Button({
          style_class: "gtime-rem-action-btn gtime-rem-delete-action",
          child: new St.Icon({
            icon_name: "edit-delete-symbolic",
            icon_size: 14,
          }),
          can_focus: true,
          y_align: Clutter.ActorAlign.CENTER,
        });
        delBtn.set_opacity(0);
        delBtn.connect("clicked", () => {
          this.reminders.splice(i, 1);
          this._scheduleNextCheck();
          this._indicator.queueSave();
          this._indicator.updatePanelFromMode();
          this._renderReminderView();
        });

        // Only show restart button if the reminder is already triggered
        if (rm.triggered) {
          actionsBox.add_child(restartBtn);
        }
        actionsBox.add_child(editBtn);
        actionsBox.add_child(delBtn);

        header.add_child(titleBox);
        header.add_child(actionsBox);
        card.add_child(header);

        const updateActionButtonsOpacity = () => {
          const isFocused =
            editBtn.has_key_focus() ||
            delBtn.has_key_focus() ||
            (rm.triggered && restartBtn.has_key_focus());
          const op = card.hover || isFocused ? 255 : 0;
          if (rm.triggered) {
            restartBtn.ease({
              opacity: op,
              duration: 150,
              mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
          }
          editBtn.ease({
            opacity: op,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          });
          delBtn.ease({
            opacity: op,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
          });
        };

        card.connect("notify::hover", updateActionButtonsOpacity);
        for (const btn of [restartBtn, editBtn, delBtn]) {
          btn.connect("key-focus-in", updateActionButtonsOpacity);
          btn.connect("key-focus-out", updateActionButtonsOpacity);
        }

        content.add_child(card);
      }
    }

    listContainer.add_child(scroll);

    const addBtnContainer = new St.BoxLayout({
      style_class: "gtime-actions-row",
      x_align: Clutter.ActorAlign.CENTER,
    });
    const addBtn = new St.Button({
      label: _("Add Reminder"),
      style_class: "gtime-start-button",
      can_focus: true,
    });
    addBtn.connect("clicked", () => {
      this._editingReminderIndex = null;
      this._isAddingReminder = true;
      this._renderReminderView();
    });

    addBtnContainer.add_child(addBtn);
    this._reminderViews.add_child(listContainer);
    this._reminderViews.add_child(addBtnContainer);
  }

  _buildColon() {
    return new St.Label({
      text: ":",
      style_class: "gtime-colon",
      y_align: Clutter.ActorAlign.CENTER,
    });
  }

  _sortReminders() {
    const toEpoch = (rm) => {
      if (!rm.date || !rm.time) return Number.MAX_SAFE_INTEGER;
      const parts = rm.date.split("-");
      const tparts = rm.time.split(":");
      if (parts.length !== 3 || tparts.length !== 2)
        return Number.MAX_SAFE_INTEGER;
      const dt = GLib.DateTime.new_local(
        parseInt(parts[0], 10),
        parseInt(parts[1], 10),
        parseInt(parts[2], 10),
        parseInt(tparts[0], 10),
        parseInt(tparts[1], 10),
        0,
      );
      return dt ? dt.to_unix() : Number.MAX_SAFE_INTEGER;
    };

    this.reminders.sort((a, b) => {
      if (Boolean(a.triggered) !== Boolean(b.triggered)) {
        return a.triggered ? -1 : 1;
      }
      return toEpoch(a) - toEpoch(b);
    });
  }

  _buildReminderAddForm() {
    const form = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      y_expand: true,
      reactive: true,
    });

    const titleEntry = new St.Entry({
      hint_text: _("Remind me to..."),
      style_class: "gtime-reminder-entry",
      x_expand: true,
    });

    // Default new reminders to 5 minutes in the future so they are immediately valid
    let defaultDt = GLib.DateTime.new_now_local().add_minutes(5);
    this._newRemDate = GLib.DateTime.new_local(
      defaultDt.get_year(),
      defaultDt.get_month(),
      defaultDt.get_day_of_month(),
      0,
      0,
      0,
    );
    this._newRemHour = parseInt(defaultDt.format("%I"), 10) || 12;
    this._newRemMinute = parseInt(defaultDt.format("%M"), 10);
    this._newRemAmPm = defaultDt.format("%p");

    if (
      this._editingReminderIndex !== undefined &&
      this._editingReminderIndex !== null
    ) {
      let rm = this.reminders[this._editingReminderIndex];
      if (rm.title && rm.title !== _("Reminder") && rm.title !== "Reminder") {
        titleEntry.set_text(rm.title);
      }

      let dateParts = rm.date.split("-");
      if (dateParts.length === 3) {
        this._newRemDate = GLib.DateTime.new_local(
          parseInt(dateParts[0], 10),
          parseInt(dateParts[1], 10),
          parseInt(dateParts[2], 10),
          0,
          0,
          0,
        );
      }

      let tParts = null;
      if (rm.displayTime) {
        let match = rm.displayTime.match(/(\d+):(\d+)\s*(AM|PM)/i);
        if (match) tParts = match;
      } else if (rm.time) {
        let parts = rm.time.split(":");
        if (parts.length === 2) {
          let h = parseInt(parts[0], 10);
          let m = parseInt(parts[1], 10);
          let ampm = h >= 12 ? "PM" : "AM";
          let h12 = h % 12 || 12;
          tParts = [null, h12.toString(), m.toString(), ampm];
        }
      }

      if (tParts) {
        this._newRemHour = parseInt(tParts[1], 10);
        this._newRemMinute = parseInt(tParts[2], 10);
        this._newRemAmPm = tParts[3].toUpperCase();
      }
    }

    const pickerRow = new St.BoxLayout({
      style_class: "gtime-picker-row",
      y_align: Clutter.ActorAlign.CENTER,
    });

    let hourCol, minCol;
    let hourValLabel, minValLabel, ampmBtn;
    let hourMinusBtn, minMinusBtn;
    let saveBtn, statusHintLabel;
    let isSyncingFields = false;

    const setActiveCol = (activeType) => {
      if (hourCol) {
        if (activeType === "h")
          hourCol.add_style_class_name("gtime-time-column-active");
        else hourCol.remove_style_class_name("gtime-time-column-active");
      }
      if (minCol) {
        if (activeType === "m")
          minCol.add_style_class_name("gtime-time-column-active");
        else minCol.remove_style_class_name("gtime-time-column-active");
      }
    };

    form.connect("button-press-event", () => {
      form.grab_key_focus();
      setActiveCol(null);
      return Clutter.EVENT_PROPAGATE;
    });

    const getTargetDateTime = () => {
      let h24 = this._newRemHour;
      if (this._newRemAmPm === "AM" && h24 === 12) h24 = 0;
      if (this._newRemAmPm === "PM" && h24 !== 12) h24 += 12;
      return GLib.DateTime.new_local(
        this._newRemDate.get_year(),
        this._newRemDate.get_month(),
        this._newRemDate.get_day_of_month(),
        h24,
        this._newRemMinute,
        0,
      );
    };

    const formatRelativePreview = (targetDt, nowDt) => {
      const diffMins = Math.ceil(targetDt.difference(nowDt) / 60000000);
      if (diffMins <= 0) return null;
      if (diffMins < 60) {
        return `${_("Rings in")} ${diffMins}m`;
      } else if (diffMins < 1440) {
        const h = Math.floor(diffMins / 60);
        const m = diffMins % 60;
        return m > 0
          ? `${_("Rings in")} ${h}h ${m}m`
          : `${_("Rings in")} ${h}h`;
      } else {
        const d = Math.floor(diffMins / 1440);
        const remH = Math.floor((diffMins % 1440) / 60);
        return remH > 0
          ? `${_("Rings in")} ${d}d ${remH}h`
          : `${_("Rings in")} ${d}d`;
      }
    };

    let syncTimeDisplay = null;
    let updateDateDisplay = null;

    const actionAddMinutes = (minutes) => {
      setActiveCol(null);
      let now = GLib.DateTime.new_now_local();
      let baseDt = getTargetDateTime();
      // If the currently displayed time is in the past, add relative to 'now'
      if (!baseDt || baseDt.compare(now) < 0) {
        baseDt = now;
      }
      let dt = baseDt.add_minutes(minutes);

      this._newRemDate = GLib.DateTime.new_local(
        dt.get_year(),
        dt.get_month(),
        dt.get_day_of_month(),
        0,
        0,
        0,
      );
      this._newRemHour = parseInt(dt.format("%I"), 10) || 12;
      this._newRemMinute = parseInt(dt.format("%M"), 10);
      this._newRemAmPm = dt.format("%p");

      if (updateDateDisplay) updateDateDisplay();
      if (syncTimeDisplay) syncTimeDisplay(true);
    };

    const quickGrid = new St.BoxLayout({
      vertical: true,
      style_class: "gtime-quick-grid",
      y_align: Clutter.ActorAlign.CENTER,
    });
    const quickBtns = [
      { label: "+10m", m: 10 },
      { label: "+2h", m: 120 },
      { label: "+15m", m: 15 },
      { label: "+3h", m: 180 },
      { label: "+30m", m: 30 },
      { label: "+5h", m: 300 },
    ];

    const row1 = new St.BoxLayout({
      style_class: "gtime-quick-row",
      x_expand: true,
    });
    const row2 = new St.BoxLayout({
      style_class: "gtime-quick-row",
      x_expand: true,
    });
    const row3 = new St.BoxLayout({
      style_class: "gtime-quick-row",
      x_expand: true,
    });

    quickBtns.forEach((item, index) => {
      const button = new St.Button({
        label: item.label,
        style_class: "gtime-quick-button",
        can_focus: true,
        x_expand: true,
      });
      button.connect("clicked", () => actionAddMinutes(item.m));
      if (index < 2) {
        row1.add_child(button);
      } else if (index < 4) {
        row2.add_child(button);
      } else {
        row3.add_child(button);
      }
    });

    quickGrid.add_child(row1);
    quickGrid.add_child(row2);
    quickGrid.add_child(row3);

    const dateRow = new St.BoxLayout({
      style_class: "gtime-date-row",
      x_expand: true,
      reactive: true,
    });

    const prevDateBtn = new St.Button({
      style_class: "gtime-date-nav-button gtime-date-nav-left",
      can_focus: true,
      child: new St.Icon({ icon_name: "go-previous-symbolic", icon_size: 16 }),
    });

    const dateEntry = new St.Entry({
      style_class: "gtime-date-entry",
      can_focus: true,
      x_expand: true,
    });
    dateEntry.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
    dateEntry.clutter_text.set_y_align(Clutter.ActorAlign.CENTER);
    dateEntry.clutter_text.editable = false;

    const nextDateBtn = new St.Button({
      style_class: "gtime-date-nav-button gtime-date-nav-right",
      can_focus: true,
      child: new St.Icon({ icon_name: "go-next-symbolic", icon_size: 16 }),
    });

    updateDateDisplay = () => {
      let today = GLib.DateTime.new_now_local();
      let todayStart = GLib.DateTime.new_local(
        today.get_year(),
        today.get_month(),
        today.get_day_of_month(),
        0,
        0,
        0,
      );

      if (this._newRemDate.compare(todayStart) < 0) {
        this._newRemDate = todayStart;
      }

      let fullStr = this._newRemDate.format("%Y-%m-%d");
      let dayName = this._newRemDate.format("%a");

      if (fullStr === today.format("%Y-%m-%d")) {
        prevDateBtn.reactive = false;
        prevDateBtn.can_focus = false;
        prevDateBtn.add_style_class_name("gtime-date-nav-button-disabled");
        dateEntry.set_text(`${_("Today")} (${dayName} ${fullStr})`);
      } else {
        prevDateBtn.reactive = true;
        prevDateBtn.can_focus = true;
        prevDateBtn.remove_style_class_name("gtime-date-nav-button-disabled");
        if (fullStr === today.add_days(1).format("%Y-%m-%d")) {
          dateEntry.set_text(`${_("Tomorrow")} (${dayName} ${fullStr})`);
        } else {
          dateEntry.set_text(`${dayName}, ${fullStr}`);
        }
      }
      if (syncTimeDisplay) syncTimeDisplay(true);
    };

    nextDateBtn.connect("clicked", () => {
      this._newRemDate = this._newRemDate.add_days(1);
      updateDateDisplay();
    });
    prevDateBtn.connect("clicked", () => {
      this._newRemDate = this._newRemDate.add_days(-1);
      updateDateDisplay();
    });

    dateRow.connect("scroll-event", (_actor, event) => {
      const direction = event.get_scroll_direction();
      if (direction === Clutter.ScrollDirection.UP) {
        this._newRemDate = this._newRemDate.add_days(1);
        updateDateDisplay();
        return Clutter.EVENT_STOP;
      } else if (direction === Clutter.ScrollDirection.DOWN) {
        this._newRemDate = this._newRemDate.add_days(-1);
        updateDateDisplay();
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });

    dateEntry.clutter_text.connect("key-press-event", (_actor, event) => {
      const key = event.get_key_symbol();
      if (key === Clutter.KEY_Up) {
        this._newRemDate = this._newRemDate.add_days(1);
        updateDateDisplay();
        return Clutter.EVENT_STOP;
      } else if (key === Clutter.KEY_Down) {
        this._newRemDate = this._newRemDate.add_days(-1);
        updateDateDisplay();
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_STOP;
    });

    dateRow.add_child(prevDateBtn);
    dateRow.add_child(dateEntry);
    dateRow.add_child(nextDateBtn);

    syncTimeDisplay = (formatTextEntries = true) => {
      let now = GLib.DateTime.new_now_local();
      let nowMinuteFloor = GLib.DateTime.new_local(
        now.get_year(),
        now.get_month(),
        now.get_day_of_month(),
        now.get_hour(),
        now.get_minute(),
        0,
      );

      let targetDt = getTargetDateTime();
      // A reminder is valid if its target minute is strictly in the future
      let isValidFuture =
        targetDt !== null && targetDt.compare(nowMinuteFloor) > 0;

      if (formatTextEntries) {
        isSyncingFields = true;
        if (hourValLabel)
          hourValLabel.set_text(this._newRemHour.toString().padStart(2, "0"));
        if (minValLabel)
          minValLabel.set_text(this._newRemMinute.toString().padStart(2, "0"));
        isSyncingFields = false;
      }

      if (ampmBtn) {
        ampmBtn.set_label(this._newRemAmPm);
      }

      if (hourCol && minCol) {
        if (!isValidFuture) {
          hourCol.add_style_class_name("gtime-time-column-past");
          minCol.add_style_class_name("gtime-time-column-past");
        } else {
          hourCol.remove_style_class_name("gtime-time-column-past");
          minCol.remove_style_class_name("gtime-time-column-past");
        }
      }

      if (statusHintLabel) {
        if (isValidFuture) {
          statusHintLabel.set_text(formatRelativePreview(targetDt, now) || "");
          statusHintLabel.remove_style_class_name(
            "gtime-rem-status-hint-error",
          );
        } else {
          statusHintLabel.set_text(_("Selected time has already passed today"));
          statusHintLabel.add_style_class_name("gtime-rem-status-hint-error");
        }
      }

      if (saveBtn) {
        saveBtn.reactive = isValidFuture;
        saveBtn.can_focus = isValidFuture;
        if (isValidFuture) {
          saveBtn.remove_style_class_name("gtime-start-button-disabled");
        } else {
          saveBtn.add_style_class_name("gtime-start-button-disabled");
        }
      }
    };

    const createTimeCol = (type) => {
      const col = new St.BoxLayout({
        vertical: true,
        style_class: "gtime-time-column",
        x_expand: false,
        y_align: Clutter.ActorAlign.CENTER,
        reactive: true,
      });

      const plusBtn = new St.Button({
        label: "+",
        style_class: "gtime-step-button gtime-step-button-top",
        can_focus: true,
      });

      let valLabel = new St.Entry({
        style_class: "gtime-value-entry",
        can_focus: true,
        x_expand: true,
        y_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
      });
      valLabel.clutter_text.set_x_align(Clutter.ActorAlign.CENTER);
      valLabel.clutter_text.set_y_align(Clutter.ActorAlign.CENTER);

      let minusBtn = new St.Button({
        label: "-",
        style_class: "gtime-step-button gtime-step-button-bottom",
        can_focus: true,
      });

      if (type === "h") {
        hourValLabel = valLabel;
        hourMinusBtn = minusBtn;
      } else if (type === "m") {
        minValLabel = valLabel;
        minMinusBtn = minusBtn;
      }

      const adjust = (delta) => {
        setActiveCol(type);
        if (type === "h") {
          let prevHour = this._newRemHour;
          this._newRemHour += delta;
          if (this._newRemHour > 12) this._newRemHour = 1;
          else if (this._newRemHour < 1) this._newRemHour = 12;

          // Automatically flip AM/PM when crossing 11 <-> 12
          if (
            (prevHour === 11 && this._newRemHour === 12) ||
            (prevHour === 12 && this._newRemHour === 11)
          ) {
            this._newRemAmPm = this._newRemAmPm === "AM" ? "PM" : "AM";
          }
        } else if (type === "m") {
          this._newRemMinute += delta;
          if (this._newRemMinute > 59) {
            this._newRemMinute = 0;
          } else if (this._newRemMinute < 0) {
            this._newRemMinute = 59;
          }
        }
        syncTimeDisplay(true);
      };

      plusBtn.connect("clicked", () => adjust(1));
      minusBtn.connect("clicked", () => adjust(-1));

      col.connect("scroll-event", (_actor, event) => {
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.UP) {
          adjust(1);
          return Clutter.EVENT_STOP;
        } else if (direction === Clutter.ScrollDirection.DOWN) {
          adjust(-1);
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
      });

      valLabel.connect("key-focus-in", () => {
        setActiveCol(type);
        return Clutter.EVENT_PROPAGATE;
      });

      valLabel.connect("key-focus-out", () => {
        setActiveCol(null);
        syncTimeDisplay(true);
        return Clutter.EVENT_PROPAGATE;
      });

      valLabel.clutter_text.connect("activate", () => {
        syncTimeDisplay(true);
        if (saveBtn && saveBtn.reactive) {
          saveBtn.emit("clicked", 1);
        }
      });

      valLabel.clutter_text.connect("key-press-event", (_actor, event) => {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Up) {
          adjust(1);
          return Clutter.EVENT_STOP;
        } else if (key === Clutter.KEY_Down) {
          adjust(-1);
          return Clutter.EVENT_STOP;
        } else if (
          key === Clutter.KEY_Tab ||
          key === Clutter.KEY_KP_Tab ||
          key === Clutter.KEY_ISO_Left_Tab
        ) {
          const targetEntry = type === "h" ? minValLabel : hourValLabel;
          if (targetEntry) {
            targetEntry.grab_key_focus();
            setActiveCol(type === "h" ? "m" : "h");
          }
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
      });

      valLabel.clutter_text.connect("text-changed", () => {
        if (isSyncingFields) return;
        let rawText = valLabel.get_text();
        let digitsOnly = rawText.replace(/\D/g, "").slice(-2);
        const maxVal = type === "h" ? 12 : 59;

        if (digitsOnly.length > 0) {
          let parsed = parseInt(digitsOnly, 10);
          if (parsed > maxVal) {
            const lastDigit = parseInt(digitsOnly.slice(-1), 10);
            if (type === "h") {
              parsed = lastDigit >= 1 && lastDigit <= 9 ? lastDigit : 12;
            } else {
              parsed = lastDigit <= 59 ? lastDigit : 59;
            }
            digitsOnly = parsed.toString().padStart(2, "0");
          }
          if (type === "h") {
            this._newRemHour = parsed === 0 ? 12 : parsed;
          } else {
            this._newRemMinute = parsed;
          }
        }

        if (digitsOnly !== rawText) {
          isSyncingFields = true;
          valLabel.set_text(digitsOnly);
          isSyncingFields = false;
        }

        syncTimeDisplay(false);
      });

      col.add_child(plusBtn);
      col.add_child(valLabel);
      col.add_child(minusBtn);
      return col;
    };

    hourCol = createTimeCol("h");
    const colon = this._buildColon();
    minCol = createTimeCol("m");

    ampmBtn = new St.Button({
      label: this._newRemAmPm,
      style_class: "gtime-quick-button gtime-ampm-button-rem",
      x_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.CENTER,
      can_focus: true,
      reactive: true,
    });

    ampmBtn.connect("clicked", () => {
      setActiveCol(null);
      this._newRemAmPm = this._newRemAmPm === "AM" ? "PM" : "AM";
      syncTimeDisplay(true);
    });

    ampmBtn.connect("scroll-event", (_actor, event) => {
      const direction = event.get_scroll_direction();
      if (
        direction === Clutter.ScrollDirection.UP ||
        direction === Clutter.ScrollDirection.DOWN
      ) {
        this._newRemAmPm = this._newRemAmPm === "AM" ? "PM" : "AM";
        syncTimeDisplay(true);
        return Clutter.EVENT_STOP;
      }
      return Clutter.EVENT_PROPAGATE;
    });

    pickerRow.add_child(hourCol);
    pickerRow.add_child(colon);
    pickerRow.add_child(minCol);

    const timeBlockContainer = new St.BoxLayout({
      vertical: true,
      x_expand: false,
      y_align: Clutter.ActorAlign.CENTER,
    });
    timeBlockContainer.add_child(pickerRow);
    timeBlockContainer.add_child(ampmBtn);

    form.add_child(titleEntry);

    const dateTimeContainer = new St.BoxLayout({
      vertical: true,
      x_expand: true,
    });

    dateTimeContainer.add_child(dateRow);

    const pickerAndQuickRow = new St.BoxLayout({
      x_expand: true,
      y_align: Clutter.ActorAlign.CENTER,
    });

    pickerRow.x_expand = false;
    pickerAndQuickRow.add_child(timeBlockContainer);
    pickerAndQuickRow.add_child(new St.Widget({ x_expand: true }));
    pickerAndQuickRow.add_child(quickGrid);

    dateTimeContainer.add_child(pickerAndQuickRow);

    statusHintLabel = new St.Label({
      text: "",
      style_class: "gtime-rem-status-hint",
      x_align: Clutter.ActorAlign.CENTER,
      x_expand: true,
    });
    dateTimeContainer.add_child(statusHintLabel);

    form.add_child(dateTimeContainer);
    form.add_child(new St.Widget({ y_expand: true }));

    const actions = new St.BoxLayout({
      style_class: "gtime-actions-row",
      x_align: Clutter.ActorAlign.CENTER,
    });
    const cancelBtn = new St.Button({
      label: _("Cancel"),
      style_class: "gtime-cancel-button",
      can_focus: true,
    });
    cancelBtn.connect("clicked", () => {
      this._editingReminderIndex = null;
      this._isAddingReminder = false;
      this._renderReminderView();
    });

    saveBtn = new St.Button({
      label: _("Save"),
      style_class: "gtime-start-button",
      can_focus: true,
    });

    // Initialize date and time displays & validation state now that saveBtn exists
    updateDateDisplay();
    syncTimeDisplay(true);

    saveBtn.connect("clicked", () => {
      syncTimeDisplay(true);
      if (!saveBtn.reactive) return;

      let h24 = this._newRemHour;
      if (this._newRemAmPm === "AM" && h24 === 12) h24 = 0;
      if (this._newRemAmPm === "PM" && h24 !== 12) h24 += 12;
      let t24Str =
        h24.toString().padStart(2, "0") +
        ":" +
        this._newRemMinute.toString().padStart(2, "0");
      let displayTime =
        this._newRemHour.toString().padStart(2, "0") +
        ":" +
        this._newRemMinute.toString().padStart(2, "0") +
        " " +
        this._newRemAmPm;

      let triggerDt = getTargetDateTime();
      let nowDt = GLib.DateTime.new_now_local();
      let diffMins = Math.floor(triggerDt.difference(nowDt) / 60000000);
      if (diffMins < 1) diffMins = 1;

      let existingRem =
        this._editingReminderIndex !== null &&
        this._editingReminderIndex !== undefined
          ? this.reminders[this._editingReminderIndex]
          : null;

      let newReminder = {
        id: existingRem ? existingRem.id : Date.now().toString(),
        title: titleEntry.get_text().trim() || _("Reminder"),
        date: this._newRemDate.format("%Y-%m-%d"),
        time: t24Str,
        displayTime: displayTime,
        triggered: false,
        durationMins: existingRem
          ? existingRem.durationMins || diffMins
          : diffMins,
      };

      if (
        this._editingReminderIndex !== null &&
        this._editingReminderIndex !== undefined
      ) {
        this.reminders[this._editingReminderIndex] = newReminder;
      } else {
        this.reminders.push(newReminder);
      }

      this._sortReminders();
      this._scheduleNextCheck();
      this._editingReminderIndex = null;
      this._indicator.queueSave();
      this._indicator.updatePanelFromMode();
      this._isAddingReminder = false;
      this._renderReminderView();
    });

    titleEntry.clutter_text.connect("activate", () => {
      if (saveBtn.reactive) {
        saveBtn.emit("clicked", 1);
      }
    });

    actions.add_child(cancelBtn);
    actions.add_child(saveBtn);
    form.add_child(actions);

    this._reminderViews.add_child(form);

    if (this._focusIdleId) {
      GLib.source_remove(this._focusIdleId);
    }
    this._focusIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      this._focusIdleId = null;
      if (titleEntry) titleEntry.grab_key_focus();
      return GLib.SOURCE_REMOVE;
    });
    GLib.Source.set_name_by_id(this._focusIdleId, "[g-time] focus-reminder");
  }

  _checkReminders() {
    let changed = false;
    let now = GLib.DateTime.new_now_local();

    for (let rm of this.reminders) {
      if (!rm.triggered && rm.date && rm.time) {
        let parts = rm.date.split("-");
        let tparts = rm.time.split(":");
        if (parts.length === 3 && tparts.length === 2) {
          let rd = GLib.DateTime.new_local(
            parseInt(parts[0], 10),
            parseInt(parts[1], 10),
            parseInt(parts[2], 10),
            parseInt(tparts[0], 10),
            parseInt(tparts[1], 10),
            0,
          );
          if (rd && now.compare(rd) >= 0) {
            rm.triggered = true;
            changed = true;

            try {
              const source = MessageTray.getSystemNotifyingSource();
              const notification = new MessageTray.Notification({
                source,
                title: _("Reminder: ") + rm.title,
                body: rm.displayTime || rm.time,
                isTransient: false,
              });

              notification.addAction(_("Snooze 10m"), () => {
                rm.triggered = false;
                let triggerDt = GLib.DateTime.new_now_local().add_minutes(10);
                rm.date = triggerDt.format("%Y-%m-%d");
                rm.time = triggerDt.format("%H:%M");
                let h12 = parseInt(triggerDt.format("%I"), 10) || 12;
                let mStr = triggerDt.format("%M");
                let ampm = triggerDt.format("%p");
                rm.displayTime = `${h12.toString().padStart(2, "0")}:${mStr} ${ampm}`;
                this._scheduleNextCheck();
                this._indicator.queueSave();
                this._indicator.updatePanelFromMode();
                this._renderReminderView();
              });

              source.addNotification(notification);
            } catch (e) {
              console.error("[g-time] Advanced notification failed: ", e);
              Main.notify(
                _("Reminder: ") + rm.title,
                rm.displayTime || rm.time,
              );
            }

            try {
              global.display
                .get_sound_player()
                .play_from_theme("complete", _("Reminder Triggered"), null);
            } catch (e) {
              console.warn("[g-time] Failed to play reminder sound", e);
            }
          }
        }
      }
    }
    if (changed) {
      this._indicator.queueSave();
      this._indicator.updatePanelFromMode();
      this._renderReminderView();
    }
    this._scheduleNextCheck();
    return GLib.SOURCE_REMOVE;
  }
}
