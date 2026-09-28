import packageJson from "../../package.json" with { type: "json" };

/** The installed forge's version, embedded at build time from package.json. */
export const FORGE_VERSION: string = packageJson.version;
