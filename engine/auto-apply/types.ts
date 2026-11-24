/**
 * 批量队列 / 消息记录匹配用到的岗位字段。
 * 插件侧岗位对象来自 normalizeJob，字段更全；这里只声明引擎内部读取的部分。
 */
export type AutoApplyJob = {
  id?: string;
  source: string;
  company: string;
  title: string;
  city?: string;
  sourceUrl: string;
  jobId?: string;
  recruiter?: string;
  companyAnonymous?: boolean;
  submittedAt?: number;
  [key: string]: unknown;
};
