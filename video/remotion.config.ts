import { Config } from "@remotion/cli/config";

// PNG frames are lossless — keeps text crisp before encoding (jpeg softens edges).
Config.setVideoImageFormat("png");
Config.setOverwriteOutput(true);
