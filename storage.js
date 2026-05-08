import GLib from "gi://GLib";
import Gio from "gi://Gio";
import { STORAGE_FILENAME } from "./constants.js";

export class TimeStorage {
  constructor() {
    this._dirPath = GLib.build_filenamev([GLib.get_user_data_dir(), "g-time"]);
    this._filePath = GLib.build_filenamev([this._dirPath, STORAGE_FILENAME]);
    if (!GLib.file_test(this._dirPath, GLib.FileTest.EXISTS)) {
      GLib.mkdir_with_parents(this._dirPath, 0o755);
    }
  }

  async readState() {
    const file = Gio.File.new_for_path(this._filePath);
    return new Promise((resolve, reject) => {
      file.load_contents_async(null, (source, result) => {
        try {
          const [success, contents] = source.load_contents_finish(result);
          if (!success) {
            resolve(null);
            return;
          }
          resolve(JSON.parse(new TextDecoder().decode(contents)));
        } catch (e) {
          resolve(null);
        }
      });
    });
  }

  async saveState(state) {
    const dataStr = JSON.stringify(state, null, 2);
    const file = Gio.File.new_for_path(this._filePath);
    const bytes = new TextEncoder().encode(dataStr);

    return new Promise((resolve) => {
      file.replace_contents_async(
        bytes,
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null,
        (source, result) => {
          try {
            source.replace_contents_finish(result);
            resolve(true);
          } catch (e) {
            console.error(`[g-time] Error saving async storage: ${e}`);
            resolve(false);
          }
        },
      );
    });
  }

  saveStateSync(state) {
    const dataStr = JSON.stringify(state, null, 2);

    try {
      GLib.file_set_contents(this._filePath, dataStr);
      return true;
    } catch (e) {
      console.error(`[g-time] Error saving storage sync: ${e}`);
      return false;
    }
  }
}
