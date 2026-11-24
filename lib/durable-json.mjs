import fs from "node:fs/promises";

/** 先写临时文件再改名：进程被杀时不会留下半截 JSON。 */
export async function atomicWriteFile(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, data, "utf8");
    try {
      await fs.rename(tmp, file);
    } catch {
      // Windows 上目标文件被占用时 rename 会失败，先删再改名。
      await fs.rm(file, { force: true });
      await fs.rename(tmp, file);
    }
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 文件损坏时留一份副本再重建，避免用户数据被静默清空。 */
export async function backupCorruptFile(file) {
  const backup = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await fs.copyFile(file, backup).catch(() => undefined);
  return backup;
}
