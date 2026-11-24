/**
 * 公司名归一化：与宿主 / 后端 CompanyNameKey 保持同一套规则，
 * 否则同一家公司会在投递台账、公司情报和云端反馈之间分裂成多条。
 */
export function companyNameKey(name) {
  let text = String(name ?? "").trim().toLowerCase();
  if (!text) return "";
  text = text.replace(/[\s!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~，。、；：！？“”‘’（）【】·—－_]+/g, "");
  const suffixes = ["股份有限公司", "有限责任公司", "有限公司", "集团有限公司", "集团", "分公司", "公司", "总部"];
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of suffixes) {
      if (text.endsWith(suffix) && text.length > suffix.length + 1) {
        text = text.slice(0, -suffix.length);
        changed = true;
      }
    }
  }
  return text.slice(0, 200);
}

const ANONYMOUS = /未公开|匿名|保密公司|某公司/;

export function isAnonymousCompany(name) {
  const value = String(name ?? "").trim();
  return !value || ANONYMOUS.test(value);
}
