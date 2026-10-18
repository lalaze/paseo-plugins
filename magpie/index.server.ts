import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readConfig } from "./server/config";
import { MagpieApi } from "./server/api";
import { act, loadPage, pluginCatalog, signin, transcript } from "./server/service";
import {
  readJob,
  readPage,
  readPluginCatalog,
  readTranscript,
  runAction,
  signIn,
} from "./shared/rpc";
import { Jobs } from "./server/jobs";

export default function contribute(server: PluginServerContext) {
  let api: Promise<MagpieApi> | undefined;
  const jobs = new Jobs();
  const connect = () => {
    if (!api)
      api = readConfig()
        .then((config) => new MagpieApi(config))
        .catch((error) => {
          api = undefined;
          throw error;
        });
    return api;
  };
  server.handle(readPage, async (input) => loadPage(await connect(), input));
  server.handle(readPluginCatalog, async (input) => pluginCatalog(await connect(), input));
  server.handle(runAction, async (input) => {
    const api = await connect();
    if (["plugin.add", "plugin.upgrade", "library.skill.install"].includes(input.type))
      return jobs.start(() => act(api, input));
    return { ...(await act(api, input)), jobId: "" };
  });
  server.handle(readJob, (input) => jobs.read(input.id));
  server.handle(signIn, async (input) => signin(await connect(), input));
  server.handle(readTranscript, async (input) => transcript(await connect(), input));
  return async () => {
    jobs.clear();
    (await api?.catch(() => undefined))?.close();
  };
}
