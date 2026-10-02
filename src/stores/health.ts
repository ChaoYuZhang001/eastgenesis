// 模型与决策后端的健康度，整个应用共用一份。
// 跨任务共用：一个模型熔断后，其他任务的路由也能看到；手动干预面板也用它判断可用性。
// 设置页改了某个 Provider 的配置后由 settings store 调 resetProvider，不用重启应用。
import { HealthTracker } from "@/decision";

export const health = new HealthTracker();
