import { copyFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import os from "os";

const vaultPath =
  process.env.OBSIDIAN_VAULT_PATH ?? join(os.homedir(), "e", "Obsidian Vault");
const pluginId = "inline-kanban";
const pluginDir = join(vaultPath, ".obsidian", "plugins", pluginId);
const rootDir = process.cwd();

if (!existsSync(vaultPath)) {
  throw new Error(
    `Vault path does not exist: ${vaultPath}. Set OBSIDIAN_VAULT_PATH to override.`,
  );
}

mkdirSync(pluginDir, { recursive: true });

const requiredFiles = ["manifest.json", "main.js", "styles.css"];
const optionalFiles = ["main.js.map"];

const copy = (fileName, required) => {
  const src = join(rootDir, fileName);
  const dest = join(pluginDir, fileName);

  if (!existsSync(src)) {
    if (required) {
      throw new Error(`Missing required build file: ${fileName}`);
    }
    console.warn(`Skipping missing optional file: ${fileName}`);
    return;
  }

  copyFileSync(src, dest);
  console.log(`Copied ${fileName} -> ${dest}`);
};

for (const fileName of requiredFiles) copy(fileName, true);
for (const fileName of optionalFiles) copy(fileName, false);

console.log(`Inline Kanban deployed to ${pluginDir}`);
