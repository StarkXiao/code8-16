// 领域常量：默认阈值、问题类型、申诉理由（唯一来源）

export const SCHEMA_VERSION = 1;

/** 核验默认阈值（可在任务输入 config 中覆盖） */
export const DEFAULT_CONFIG = {
  minCoverageRatio: 0.97, // 覆盖率低于此值判不合格
  maxOffFieldRatio: 0.02, // 界外喷洒面积占比上限
  maxOverlapRatio: 0.2, // 重喷（>=2 个架次行带）面积占比上限
  minFindingAreaM2: 4, // 漏喷/重喷/界外连通域最小面积，低于此视为覆盖边缘噪声
  minValveGapSec: 8, // 认定"断喷"的最短喷洒中断时长（秒）
  cellDivisor: 4, // 栅格边长 = 喷幅 / 此值
  maxPointGapSec: 10, // 相邻航迹点间隔超过此值 → 航迹缺失告警
  nominalAltitudeM: 2.5, // 标准作业高度（米）
  altitudeTolerance: 0.3, // 高度允许偏差 ±30%
  speedRange: [1, 10], // 作业速度合理区间（m/s）
  appealWindowDays: 7, // 申诉期限
};

/** 问题类型（kind → 中文名称、默认严重级别） */
export const FINDING_TYPES = {
  miss_interior: { label: '漏喷 · 内部遗漏', severity: 'major' },
  miss_edge: { label: '漏喷 · 边缘遗漏', severity: 'major' },
  valve_gap: { label: '漏喷 · 断喷', severity: 'major' },
  overlap: { label: '重喷', severity: 'minor' },
  off_field: { label: '界外喷洒', severity: 'minor' },
  nofly: { label: '禁飞区喷洒', severity: 'critical' },
};

/** 该类型问题是否可直接驱动"不合格" */
export const FAIL_DRIVERS = new Set([
  'miss_interior',
  'miss_edge',
  'valve_gap',
  'nofly',
]);

/** 可申诉理由（预设清单，提交时必须引用其一，可附说明与证据） */
export const APPEAL_REASONS = {
  OBSTACLE: '障碍物绕飞（树/电线杆/拉线），漏喷不可避免',
  WIND: '风力超限/药液漂移，记录与实际落药位置存在偏差',
  LOG_FAULT: '设备日志故障，喷洒记录不完整（有视频/流量计凭证）',
  REENTRY: '已在后续架次补喷，漏喷实际不存在',
  GPS_DRIFT: '定位漂移，航迹坐标不可信（RTK 原始数据可查）',
  NOFLY_MISMATCH: '禁飞区边界登记错误/已解除',
  FIELD_BOUNDARY: '地块边界登记错误，该区域不属于本次作业地块',
  OTHER: '其他（须在说明中写明）',
};

/** 申诉状态机 */
export const APPEAL_STATUS = {
  OPEN: 'open', // 待受理
  APPROVED: 'approved', // 认可：该条不纳入不合格判定
  REJECTED: 'rejected', // 驳回
  WITHDRAWN: 'withdrawn', // 申诉人撤回
};

export const DATA_WARNINGS = {
  GPS_GAP: '航迹点间隔过大（可能存在定位中断），中断期间无法核验',
  COVERAGE_TOO_LOW: '可核验覆盖率极低，输入数据可能不是同一地块/同一架次',
  ALTITUDE: '存在显著偏离标准作业高度的航迹段',
  SPEED: '存在超出合理区间的作业速度点',
  NO_SPRAY_EVENTS: '无任何喷洒记录，无法核验实际喷洒',
  NO_POINTS: '无航迹点，无法核验',
  TIME_INVERSION: '航迹时间戳存在倒流',
};
