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
    scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);

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
          text: (rm.displayTime || rm.time) + "  \u2022  " + rm.date,
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

        card.connect("notify::hover", () => {
          let op = card.hover ? 255 : 0;
          if (rm.triggered)
            restartBtn.ease({
              opacity: op,
              duration: 150,
              mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
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
        });

        if (rm.description) {
          let desc = new St.Label({
            text: rm.description,
            style_class: "gtime-section-subtitle",
            margin_top: 8,
          });
          desc.clutter_text.line_wrap = true;
          card.add_child(desc);
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

  _buildReminderAddForm() {
    const form = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      y_expand: true,
    });

    const titleEntry = new St.Entry({
      hint_text: _("Remind me to..."),
      style_class: "gtime-reminder-entry",
      x_expand: true,
    });
    const descEntry = { get_text: () => "" };

    let now = GLib.DateTime.new_now_local();
    this._newRemDate = now;
    this._newRemHour = parseInt(now.format("%I"), 10);
    this._newRemMinute = parseInt(now.format("%M"), 10);
    this._newRemAmPm = now.format("%p");

    if (
      this._editingReminderIndex !== undefined &&
      this._editingReminderIndex !== null
    ) {
      let rm = this.reminders[this._editingReminderIndex];
      if (rm.title && rm.title !== "Reminder") titleEntry.set_text(rm.title);
      if (rm.description) descEntry.set_text(rm.description);

      let dateParts = rm.date.split("-");
      if (dateParts.length === 3) {
        this._newRemDate = GLib.DateTime.new_local(
          parseInt(dateParts[0]),
          parseInt(dateParts[1]),
          parseInt(dateParts[2]),
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
          let h = parseInt(parts[0]);
          let m = parseInt(parts[1]);
          let ampm = h >= 12 ? "PM" : "AM";
          let h12 = h % 12;
          if (h12 === 0) h12 = 12;
          tParts = [null, h12.toString(), m.toString(), ampm];
        }
      }

      if (tParts) {
        this._newRemHour = parseInt(tParts[1]);
        this._newRemMinute = parseInt(tParts[2]);
        this._newRemAmPm = tParts[3].toUpperCase();
      }
    }

    const pickerRow = new St.BoxLayout({
      style_class: "gtime-picker-row",
      y_align: Clutter.ActorAlign.CENTER,
    });

    let syncTimeDisplay = null;
    let updateDateDisplay = null;

    const actionAddMinutes = (minutes) => {
      let h24 = this._newRemHour;
      if (this._newRemAmPm === "AM" && h24 === 12) h24 = 0;
      if (this._newRemAmPm === "PM" && h24 !== 12) h24 += 12;

      let dt = GLib.DateTime.new_local(
        this._newRemDate.get_year(),
        this._newRemDate.get_month(),
        this._newRemDate.get_day_of_month(),
        h24,
        this._newRemMinute,
        0,
      );
      dt = dt.add_minutes(minutes);

      this._newRemDate = GLib.DateTime.new_local(
        dt.get_year(),
        dt.get_month(),
        dt.get_day_of_month(),
        0,
        0,
        0,
      );
      this._newRemHour = parseInt(dt.format("%I"), 10);
      this._newRemMinute = parseInt(dt.format("%M"), 10);
      this._newRemAmPm = dt.format("%p");

      if (this._newRemHour === 0) this._newRemHour = 12;

      if (updateDateDisplay) updateDateDisplay();
      if (syncTimeDisplay) syncTimeDisplay();
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
    // Disable manual text editing for the date entry
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

      // Prevent selecting a date before today
      if (this._newRemDate.compare(todayStart) < 0) {
        this._newRemDate = todayStart;
      }

      let fullStr = this._newRemDate.format("%Y-%m-%d");
      let dayName = this._newRemDate.format("%a");

      // Disable prevDateBtn if selected date is today
      if (fullStr === today.format("%Y-%m-%d")) {
        prevDateBtn.reactive = false;
        prevDateBtn.can_focus = false;
        prevDateBtn.add_style_class_name("gtime-date-nav-button-disabled");
        dateEntry.set_text("Today (" + dayName + " " + fullStr + ")");
      } else {
        prevDateBtn.reactive = true;
        prevDateBtn.can_focus = true;
        prevDateBtn.remove_style_class_name("gtime-date-nav-button-disabled");
        if (fullStr === today.add_days(1).format("%Y-%m-%d")) {
          dateEntry.set_text("Tomorrow (" + dayName + " " + fullStr + ")");
        } else {
          dateEntry.set_text(dayName + ", " + fullStr);
        }
      }

      if (syncTimeDisplay) syncTimeDisplay();
    };
    updateDateDisplay();

    nextDateBtn.connect("clicked", () => {
      this._newRemDate = this._newRemDate.add_days(1);
      updateDateDisplay();
    });
    prevDateBtn.connect("clicked", () => {
      this._newRemDate = this._newRemDate.add_days(-1);
      updateDateDisplay();
    });

    // Only allow up/down keys to change the date, disable all other editing
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
      return Clutter.EVENT_STOP; // Prevent all other key input
    });

    dateRow.add_child(prevDateBtn);
    dateRow.add_child(dateEntry);
    dateRow.add_child(nextDateBtn);

    let hourValLabel, minValLabel, ampmBtn;
    let hourMinusBtn, minMinusBtn;

    syncTimeDisplay = () => {
      let now = GLib.DateTime.new_now_local();
      let isToday =
        this._newRemDate.get_year() === now.get_year() &&
        this._newRemDate.get_month() === now.get_month() &&
        this._newRemDate.get_day_of_month() === now.get_day_of_month();

      if (isToday) {
        let h24 = this._newRemHour;
        if (this._newRemAmPm === "AM" && h24 === 12) h24 = 0;
        if (this._newRemAmPm === "PM" && h24 !== 12) h24 += 12;

        let currentH = parseInt(now.format("%H"), 10);
        let currentM = parseInt(now.format("%M"), 10);

        if (
          h24 < currentH ||
          (h24 === currentH && this._newRemMinute < currentM)
        ) {
          this._newRemHour = parseInt(now.format("%I"), 10) || 12;
          this._newRemMinute = currentM;
          this._newRemAmPm = now.format("%p");
        }
      }

      // Disable minus buttons if selected time is current time
      let isCurrentTime = false;
      if (isToday) {
        let nowHour12 = parseInt(now.format("%I"), 10) || 12;
        let nowMinute = parseInt(now.format("%M"), 10);
        let nowAmPm = now.format("%p");
        if (
          this._newRemHour === nowHour12 &&
          this._newRemMinute === nowMinute &&
          this._newRemAmPm === nowAmPm
        ) {
          isCurrentTime = true;
        }
      }
      if (hourMinusBtn) {
        hourMinusBtn.reactive = !isCurrentTime;
        hourMinusBtn.can_focus = !isCurrentTime;
        if (isCurrentTime) {
          hourMinusBtn.add_style_class_name("gtime-step-button-disabled");
        } else {
          hourMinusBtn.remove_style_class_name("gtime-step-button-disabled");
        }
      }
      if (minMinusBtn) {
        minMinusBtn.reactive = !isCurrentTime;
        minMinusBtn.can_focus = !isCurrentTime;
        if (isCurrentTime) {
          minMinusBtn.add_style_class_name("gtime-step-button-disabled");
        } else {
          minMinusBtn.remove_style_class_name("gtime-step-button-disabled");
        }
      }

      if (hourValLabel)
        hourValLabel.set_text(this._newRemHour.toString().padStart(2, "0"));
      if (minValLabel)
        minValLabel.set_text(this._newRemMinute.toString().padStart(2, "0"));
      let canToggleAmPm = true;
      if (isToday) {
        let flippedAmPm = this._newRemAmPm === "AM" ? "PM" : "AM";
        let h24 = this._newRemHour;
        if (flippedAmPm === "AM" && h24 === 12) h24 = 0;
        if (flippedAmPm === "PM" && h24 !== 12) h24 += 12;
        let currentH = parseInt(now.format("%H"), 10);
        let currentM = parseInt(now.format("%M"), 10);
        if (
          h24 < currentH ||
          (h24 === currentH && this._newRemMinute < currentM)
        ) {
          canToggleAmPm = false;
        }
      }

      if (ampmBtn) {
        ampmBtn.set_label(this._newRemAmPm);
        ampmBtn.reactive = canToggleAmPm;
        ampmBtn.can_focus = canToggleAmPm;
        if (!canToggleAmPm) {
          ampmBtn.add_style_class_name("gtime-step-button-disabled");
        } else {
          ampmBtn.remove_style_class_name("gtime-step-button-disabled");
        }
      }
    };

    const createTimeCol = (type) => {
      const col = new St.BoxLayout({
        vertical: true,
        style_class: "gtime-time-column",
        x_expand: true,
        y_align: 0.5,
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
      valLabel.clutter_text.set_max_length(2);
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
        if (type === "h") {
          this._newRemHour += delta;
          if (this._newRemHour > 12) this._newRemHour = 1;
          else if (this._newRemHour < 1) this._newRemHour = 12;
        } else if (type === "m") {
          this._newRemMinute += delta;
          if (this._newRemMinute > 59) this._newRemMinute = 0;
          else if (this._newRemMinute < 0) this._newRemMinute = 59;
        }
        syncTimeDisplay();
      };

      plusBtn.connect("clicked", () => adjust(1));
      minusBtn.connect("clicked", () => adjust(-1));

      valLabel.clutter_text.connect("key-press-event", (_actor, event) => {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Up) {
          adjust(1);
          return Clutter.EVENT_STOP;
        } else if (key === Clutter.KEY_Down) {
          adjust(-1);
          return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
      });

      valLabel.clutter_text.connect("text-changed", () => {
        let text = valLabel.get_text();
        // Remove all non-digit characters
        let digitsOnly = text.replace(/\D/g, "");
        // Limit to 2 digits
        digitsOnly = digitsOnly.slice(0, 2);
        if (digitsOnly !== text) {
          valLabel.set_text(digitsOnly);
          return;
        }
        const num = parseInt(digitsOnly, 10);
        if (!isNaN(num)) {
          if (type === "h" && num >= 1 && num <= 12) this._newRemHour = num;
          else if (type === "m" && num >= 0 && num <= 59)
            this._newRemMinute = num;
        }
      });
      valLabel.connect("key-focus-out", () => {
        syncTimeDisplay();
        return Clutter.EVENT_PROPAGATE;
      });
      valLabel.clutter_text.connect("activate", () => {
        syncTimeDisplay();
      });

      col.add_child(plusBtn);
      col.add_child(valLabel);
      col.add_child(minusBtn);
      return col;
    };

    const hourCol = createTimeCol("h");
    const colon = this._buildColon();
    const minCol = createTimeCol("m");

    ampmBtn = new St.Button({
      label: this._newRemAmPm,
      style_class: "gtime-quick-button gtime-ampm-button-rem",
      x_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.CENTER,
    });

    // Adjust button height and width explicitly, or remove fixed width in css specifically for this
    ampmBtn.style =
      "width: 100%; border-radius: 12px; font-size: 18px; margin-top: 4px; padding: 10px 0;";

    ampmBtn.connect("clicked", () => {
      this._newRemAmPm = this._newRemAmPm === "AM" ? "PM" : "AM";
      syncTimeDisplay();
    });

    syncTimeDisplay();

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

    // Add expanding spacer to separate time fields and quick buttons evenly
    pickerAndQuickRow.add_child(new St.Widget({ x_expand: true }));
    pickerAndQuickRow.add_child(quickGrid);

    dateTimeContainer.add_child(pickerAndQuickRow);
    form.add_child(dateTimeContainer);
    form.add_child(new St.Widget({ y_expand: true }));

    const actions = new St.BoxLayout({
      style_class: "gtime-actions-row",
      x_align: 2,
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

    const saveBtn = new St.Button({
      label: _("Save"),
      style_class: "gtime-start-button",
      can_focus: true,
    });
    saveBtn.connect("clicked", () => {
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

      let triggerDt = GLib.DateTime.new_local(
        this._newRemDate.get_year(),
        this._newRemDate.get_month(),
        this._newRemDate.get_day_of_month(),
        h24,
        this._newRemMinute,
        0,
      );
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
        title: titleEntry.get_text() || "Reminder",
        description: descEntry.get_text(),
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

      this._scheduleNextCheck();
      this._editingReminderIndex = null;
      this._indicator.queueSave();
      this._indicator.updatePanelFromMode();
      this._isAddingReminder = false;
      this._renderReminderView();
    });

    actions.add_child(cancelBtn);
    actions.add_child(saveBtn);
    form.add_child(actions);

    this._reminderViews.add_child(form);

    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      if (titleEntry) titleEntry.grab_key_focus();
      return GLib.SOURCE_REMOVE;
    });
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
              // FIX 1: GNOME 46 requires an options object for the Source
              let source = new MessageTray.Source({
                title: "G-Time",
                iconName: "alarm-symbolic",
              });
              Main.messageTray.add(source);

              // FIX 2: GNOME 46 requires an options object for the Notification
              let notification = new MessageTray.Notification({
                source: source,
                title: _("Reminder: ") + rm.title,
                body: rm.description || "",
              });

              notification.addAction(_("Snooze 10m"), () => {
                rm.triggered = false;
                let triggerDt = GLib.DateTime.new_now_local().add_minutes(10);
                rm.date = triggerDt.format("%Y-%m-%d");
                rm.time = triggerDt.format("%H:%M");

                let h12 = parseInt(triggerDt.format("%I"), 10);
                let mStr = triggerDt.format("%M");
                let ampm = triggerDt.format("%p");
                if (h12 === 0) h12 = 12;
                rm.displayTime = h12.toString() + ":" + mStr + " " + ampm;

                this._scheduleNextCheck();
                this._indicator.queueSave();
                this._indicator.updatePanelFromMode();
                this._renderReminderView();
              });

              // FIX 3: Use addNotification for modern GNOME Shell
              source.addNotification(notification);
            } catch (e) {
              console.error("[g-time] Advanced notification failed: ", e);
              // Fallback if the advanced notification fails
              Main.notify(_("Reminder: ") + rm.title, rm.description || "");
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
