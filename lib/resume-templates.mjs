/**
 * 简历模板 ID / 名称白名单。
 * 与桌面端 src/lib/resume-templates.mjs 保持一致：新增模板时要两处同时登记，
 * 否则插件服务保存的简历会被主进程回读时退回默认模板。
 */
export const RESUME_TEMPLATES = [
  { id: "geek", name: "极客" },
  { id: "spring", name: "醒春" },
  { id: "dusk", name: "暮沉" },
  { id: "mist", name: "浅熏" },
  { id: "ink", name: "墨白" },
  { id: "azure", name: "天青" },
  { id: "sakura", name: "绯樱" },
  { id: "pine", name: "松石" },
  { id: "jianming", name: "简明" },
  { id: "neon", name: "霓虹" },
  { id: "form", name: "表单" },
  { id: "ice", name: "冰清" },
  { id: "cangjie", name: "苍洁" },
  { id: "business", name: "商务" },
  { id: "acid", name: "酸性" },
  { id: "luckyred", name: "幸运红" },
  { id: "grid", name: "格栅" },
  { id: "timeline", name: "年轮" },
  { id: "klein", name: "克莱因" },
  { id: "glow", name: "光影" },
  { id: "photo", name: "影调" },
  { id: "forest", name: "林间" },
  { id: "luxe", name: "鎏金" },
  { id: "arch", name: "碧湾" },
  { id: "spine", name: "书脊" },
  { id: "journal", name: "刊" },
  { id: "seal", name: "朱墨" },
  { id: "midnight", name: "夜幕" },
  { id: "wisteria", name: "藤紫" },
];

export const RESUME_TEMPLATE_IDS = RESUME_TEMPLATES.map((template) => template.id);

export const RESUME_TEMPLATE_NAMES = Object.freeze(
  Object.fromEntries(RESUME_TEMPLATES.map((template) => [template.id, template.name])),
);
