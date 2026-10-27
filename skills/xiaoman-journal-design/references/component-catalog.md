# 20 种组件 · 材料、动作与判别

这里描述已实现的结构，不是 20 张换标题的通用卡。字段与动作的最终可用性由本次输入的 `capabilities.types`、每项 `availableKinds` 及服务端投影决定。**设计提案只选型，不在返回值中附带下表材料或调用这些动作。**

| 类型 | 主要任务与独立结构 | 需要的材料 | 已有主动作／事实边界 |
| --- | --- | --- | --- |
| `agenda` 今日议程 | 看已定安排的先后与空档；时间轴是主轴 | 事项日期、可选时长／地点、是否灵活 | `schedule(date)` 记下安排；不是候选库存 |
| `time-grid` 可选时间 | 在多天、多时段交叉格里选偏好 | 时长、缓冲、slot ID 与时间／状态、冲突区间 | `choose-slot(slotId)`；未知或冲突不可当可约，选中不预订 |
| `prep` 分阶段准备 | 行动按准备阶段组织，推进当前一步 | 正式 `item.steps`，阶段与 step ID 对应 | `step(stepId,done)`；不是采购数量清单 |
| `decision` 条件比较 | 共同字段横向比较多个方案 | 正式 candidates ID，同一 criteria 与 options，已知预算／尺寸限制 | `choose(candidateId)`；只记选择，硬约束不符不可选 |
| `budget` 预算拆分 | 总额、已知分配、预留与未知报价相互核对 | 总预算、各 line ID／金额或 null、预留 | `reserve(amount)`；分配不是支付，待报价不计零元 |
| `shopping` 分组采购 | 按物品类别核对数量，区分已有和已买 | entry ID、名称、类别、数量或 null、单位、已有／已买 | `mark-bought(entryId,done)`、`quantity(entryId,quantity)`；不下单 |
| `itinerary` 路线站点 | 地点顺序加独立的空间移动连接段 | stops、起止时间、固定／可略过、legs 交通方式与分钟或 null | `set-route(omittedStopIds)`；略过站点后新直连时间必须重核，不能加旧两段 |
| `waiting` 等待回音 | 多个对象各等一份回应，明确何时跟进 | 请求 ID、对象、请求原意、unknown／waiting／agreed／declined、期限、草稿 | `save-draft(requestId,text)`；保存不发送，超时不等于拒绝 |
| `delivery` 履约进度 | 一个对象沿履约阶段和事件证据推进 | reference、stage ID 顺序、event 的阶段／时间／detail／evidence | `record-event(stageId,at,detail,evidence)`；只记已有回执，未来步骤不能自动打勾 |
| `deadline` 期限与下一步 | 一次明确截止、剩余与下一次行动 | dueAt、nextAt、nextLabel | `schedule(at,label)`；下一步不能晚于截止，已安排不等于已归还／办完 |
| `reminder` 提醒计划 | 一个及时动作和提醒时机 | at、minutesBefore，系统维护 recordedAt | `record-reminder(at,minutesBefore)`；计划保存不是通知投递 |
| `habit` 每周习惯 | 同一行为在不同日期上的记录分布 | targetPerWeek、已记 dates、IANA timeZone | `check-in(date,done)`；不记未来，缺记录不自动判失败 |
| `meal` 一餐准备 | 当前烹饪步骤与按份量缩放的材料 | baseServings、servings、ingredients、instructions ID／done／时长 | `set-servings(servings)`、`meal-step(stepId,done)`；未知量不乘零，时长不随人数等比缩放 |
| `collection` 生活收藏 | 多个未必执行的念头并存，材料与短注成对 | entry ID、title、note、可选已给 URL | `add-entry(entry)`；不强迫选赢家，不自动创建采购 |
| `documents` 材料文件夹 | 目录与当前文件详情，版本／用途／缺项 | entry ID、name、type、missing／provided、note、已给 URL | `mark-document(entryId,state)`；提供状态不是权限、读取或机构要求核验 |
| `approval` 待确认计划 | 一次特定动作的对象、时间、金额与条件 | summary、amount（无费用明确 0）、scheduledAt、conditions，系统 confirmation | `confirm()`／`revoke()`；更改事实后旧确认失效，不产生预约或付款 |
| `recovery` 受阻后的下一步 | 阻塞结论、已知／缺失证据和恢复分支 | blocker、known、missing、option ID／label、selectedOptionId | `choose-path(optionId)`；选择路径不是已重试，未知余位不等于无余位 |
| `reflection` 结束后评价 | 此刻填写主观感受，可单独确认评分 | rating 1–5 或 null、用户 text | `save-reflection(rating,text)`；不能从一句评价推断长期偏好或发外部评价 |
| `memory` 生活记忆 | 回看一个确认发生的片段，原话是主体 | text、occurredAt 或已有日期、caption | `save-memory(text,caption,occurredAt)`；未发生的计划不是回忆，无照片不加素材 |
| `handoff` 分工交接 | 谁负责、交付什么、满足何种共同条件 | people ID／name／role／tasks，condition、note | `set-owner(personId,name)`；记录负责人不表示通知、已读或对方接手 |

各类型还可能提供 `set-data(data)` 材料校对，但这是受校验的业务编辑动作；不是让设计 Agent 在布局输出中重写事实。材料 ID 必须来自正式事项；日期时间带时区；金额单位受现有契约约束，不擅自切换币种或单位。

## 选型中最容易丢失的差别

- **agenda / time-grid**：前者读已经定好的时间线；后者从二维候选里选择。把日期列表画成行程不代表时段可用。
- **prep / shopping**：行动阶段、依赖与非物品步骤；物品、数量、单位与家中库存。共享 checkbox 不等于共享内容骨架。
- **agenda / itinerary**：时间空档；地点移动。路线中的连接段要独立显示交通和未知时长。
- **waiting / delivery / handoff**：等人的回应；同一对象的履约证据链；责任与交付约定。用户点击不能替对方回应或物流平台签收。
- **decision / collection / recovery**：比较可执行方案；保留多个念头；选择怎样恢复。不能用“推荐第一项”覆盖不同意图。
- **deadline / reminder**：一段时间内必须完成的期限；一次及时提醒动作。普通生日日期不自动有倒计时或催促含义。
- **habit / prep**：同一行为跨日期；一次事项多个步骤。日期身份不能被几条普通待办替代。
- **meal / shopping**：当前做饭顺序与份量；采购数量与状态。没有食谱材料时不要从买菜清单编做法。
- **reflection / memory**：输入当下感受；之后回看故事。已结束不等于用户愿意写评价；无感受不自动总结情绪。

## 待补材料怎么处理

用户明确要管理预算、材料夹或习惯，即使字段未齐，也可以在 `availableKinds` 允许时选对应类型，交给组件显示具体缺项。没有该意图、也无该材料时，不为了“完整看板”加入空结构。已有同类型材料较长或预览截断时，保留结构与事实绑定，不能把摘要当作完整材料另行覆盖。
