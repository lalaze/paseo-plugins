import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ResponseSpeed } from "./client/response-speed";
import { ResponseSpeedSchema } from "./shared/metrics";

export default function contribute(client: PluginClientContext) {
  return client.addTimelineRenderer({
    kind: "response-speed",
    version: 1,
    schema: ResponseSpeedSchema,
    Component: ResponseSpeed,
  });
}
