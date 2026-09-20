# 无人机植保作业质量核验系统

比对**实际航迹**与**喷洒记录**，还原真实喷洒覆盖，识别**漏喷 / 重喷 / 越界 / 数据缺口**，
核验**亩用量**，输出**每条结论都带证据、可申诉**的核验报告。

零依赖，Node.js ≥ 18 即可运行。

```bash
# 跑一遍演示（生成样例 → 核验 → 出报告）
npm run demo

# 跑测试（30 个用例）
npm test
```

---

## 它解决什么

植保飞防结算与纠纷中常见一个问题：**飞手说喷了，农户说没喷**。
本系统把两份客观数据——飞控航迹、药箱喷洒记录——对齐到同一时间轴，
逐 0.5 米栅格还原"药到底落在了哪里"，给出可复核的结论：

- 每个问题项都附 **GeoJSON 证据多边形** 和 **关联航迹时间窗**，不是一句"不合格"；
- **数据缺口不算漏喷**：RTK 丢点、日志缺失的航段单独标记，避免冤判；
- 飞手可对任一问题项**申诉**，补交数据后**重核验**，原报告不篡改，新报告关联申诉单，全程留痕。

## 快速开始

```bash
# 1. 生成示例数据（160×96m 地块，内置漏喷/重喷/丢点/越界 4 类问题）
node src/cli.js gen-sample --out data/sample

# 2. 核验
node src/cli.js verify \
  --task data/sample/task.json \
  --track data/sample/track.csv \
  --spray data/sample/spray.csv \
  --out data/report

# 3. 查看结论
node src/cli.js summary --report data/report
```

## 输入数据格式

**task.json** —— 作业任务：

```json
{
  "taskId": "TASK-001",
  "boundary": [[45.752, 126.631], [45.752, 126.633], ...],
  "swathWidthM": 8,
  "plannedDosageLPerMu": 1.0,
  "thresholds": { "passMissRate": 0.01 }
}
```

**track.csv** —— 航迹（≥1Hz）：

```csv
ts,lat,lon,alt_m,speed_mps
2026-09-20T01:00:00.000Z,45.752,126.631,15,5.0
```

**spray.csv** —— 喷洒记录：

```csv
ts,spray_on,flow_lpm
2026-09-20T01:00:00.000Z,1,3.6
```

时间戳支持 ISO 8601 与 epoch 秒/毫秒。`speed_mps` 可缺省（由坐标差分估算）。

## 判定口径

1. **对齐**：航迹点按最近邻匹配喷洒记录（容差 1.5s），流量线性插值；
   匹配失败或航迹间隔 >3s 的航段记为 **unknown（数据缺口）**。
2. **覆盖还原**：有效喷洒段按半个喷幅缓冲，栅格化到 0.5m 网格。
   同一连续喷洒趟次内不重复计数，趟次之间累加覆盖次数。
3. **漏喷**：有效核验区（地块边界内缩半喷幅，剔除数据缺口）内覆盖次数为 0 的连通区域。
4. **重喷**：有效核验区内覆盖次数 ≥ 2 的连通区域。
5. **越界**：**飞机中心线**在地块外仍开喷的面积（贴边作业的喷幅外溢不算越界）。
6. **亩用量**：喷洒记录流量积分 ÷ 实际喷药面积（含边界余量带，重喷区只计一次）。
7. 面积 < 2㎡ 的区域视为栅格噪声忽略。

**结论分级**（阈值可在 task.json 的 `thresholds` 中覆盖）：

| 级别 | 条件（默认阈值） |
| --- | --- |
| `pass` 通过 | 漏喷率 ≤1%，重喷率 ≤5%，亩用量偏差 ≤8% |
| `conditional` 部分通过 | 漏喷率 ≤5%，或重喷率 ≤10%，或偏差 ≤15%（需整改/补喷） |
| `fail` 不通过 | 任一指标超出部分通过上限 |
| `insufficient_data` 数据不足 | 数据缺口面积占比 >15%，结论不可靠，需补充数据复核 |

## 申诉与复核

```bash
# 飞手对某个问题项申诉
node src/cli.js appeal --report data/report --finding F-MISSED-1 \
  --by 张三 --reason "该段实际已开喷，日志同步丢行，补交流量计原始记录"

# 核验员受理、裁定
node src/cli.js review  --report data/report --appeal AP-0001 --by 李四
node src/cli.js resolve --report data/report --appeal AP-0001 --decision accepted --by 李四

# 补交修正数据重核验：生成 reverify-v2/，原报告不动；
# 已受理申诉对应的问题若消失，申诉自动了结并关联新报告
node src/cli.js reverify --report data/report --spray data/sample/spray-corrected.csv --by 李四

# 查看申诉台账（每次状态变更都有 时间/操作人/说明）
node src/cli.js appeals --report data/report
```

规则：

- 每个问题项同一时间只允许一条未结申诉，驳回后可凭新证据再申诉；
- 越界喷洒为提示项，不参与分级，也不接受申诉；
- 只有 `accepted` 的申诉才能了结（`resolved`），状态机非法跳转会被拒绝；
- 重核验报告版本号递增并记录 `supersedes`，结论演变可审计。

## 输出

```
report/
├── report.json          指标、结论、问题项（含证据引用与关联航迹时间窗）
├── appeals.json         申诉台账
├── evidence/
│   ├── field.geojson    地块边界
│   ├── missed.geojson   漏喷区（红色多边形，含面积）
│   ├── repeated.geojson 重喷区
│   ├── unknown.geojson  数据缺口航段
│   └── track.geojson    航迹（按喷洒状态着色）
└── reverify-v2/         复核报告（同结构）
```

GeoJSON 可直接拖入 QGIS / geojson.io 与底图核对。

## 结构

```
src/
├── geo.js       投影、多边形、栅格、连通域（零依赖几何库）
├── models.js    输入解析与校验（致命错误拒绝，非致命记入数据质量）
├── align.js     航迹×喷洒记录时间对齐，切分 spray/off/unknown 航段
├── coverage.js  覆盖栅格化与漏喷/重喷/越界/缺口识别
├── dosage.js    流量积分与亩用量核验
├── verdict.js   指标分级与问题项生成
├── appeal.js    申诉状态机（submitted→under_review→accepted/rejected→resolved）
├── verify.js    核验主流程编排
├── report.js    报告与 GeoJSON 证据落盘
├── sample.js    示例数据生成器
└── cli.js       命令行入口
```

## 已知边界

- 投影采用地块中心的局部平面近似，适用于单地块 <2km 的植保场景；
- 亩用量把重喷区的额外药量摊进了全场平均，如需分区亩用量可在 `coverage.js` 的 counts 栅格上扩展；
- 未建模风速漂移与雾滴沉积分布，覆盖按喷幅几何计算。
