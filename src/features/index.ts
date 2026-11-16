// Feature modules register themselves through src/core/registry.ts when imported.
// Add new feature files here and keep the import list stable so parallel work does
// not conflict on this file.
import "./create.ts";
import "./apply.ts";
import "./invite.ts";
import "./manage.ts";
import "./recovery.ts";
import "./reminder.ts";

export async function loadFeatures(): Promise<void> {
  // Imports above perform registration as a side effect.
}
