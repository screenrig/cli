import type { VendorAdapter } from "../types.js";
import { files } from "./files.js";
// xy imports (Xibo, Yodeck): insert directly below this line.
import { xibo } from "./xibo.js";
import { yodeck } from "./yodeck.js";

// more imports (ScreenCloud, Screenly, Anthias, OptiSigns): insert directly below this line.
import { anthias } from "./anthias.js";
import { optisigns } from "./optisigns.js";
import { screencloud } from "./screencloud.js";
import { screenly } from "./screenly.js";

export const VENDORS: readonly VendorAdapter[] = [
  files,
  // xy entries: insert directly below this line.
  xibo,
  yodeck,

  // more entries: insert directly below this line.
  anthias,
  optisigns,
  screencloud,
  screenly,

];
