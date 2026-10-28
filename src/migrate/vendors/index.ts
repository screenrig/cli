import type { VendorAdapter } from "../types.js";
import { files } from "./files.js";
// xy imports (Xibo, Yodeck): insert directly below this line.
import { xibo } from "./xibo.js";
import { yodeck } from "./yodeck.js";

// more imports (ScreenCloud, Screenly, Anthias, OptiSigns): insert directly below this line.

export const VENDORS: readonly VendorAdapter[] = [
  files,
  // xy entries: insert directly below this line.
  xibo,
  yodeck,

  // more entries: insert directly below this line.

];
