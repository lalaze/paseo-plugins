import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readConfig } from "./server/config";
import { MagpieApi } from "./server/api";
import { act, loadPage, pluginCatalog, signin, transcript, gatewaySecret } from "./server/service";
import {
  readJob,
  readPage,
  readPluginCatalog,
  readTranscript,
  runAction,
  signIn,
  revealGatewayKey,
} from "./shared/rpc";
import { Jobs } from "./server/jobs";
import { featureRead, featureMutate } from "./server/features";
import { readFeature, mutateFeature } from "./shared/features";

export default function contribute(server: PluginServerContext) {
  let api: Promise<MagpieApi> | undefined;
  const jobs = new Jobs();
  let writes: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>) => {
    const result = writes.catch(() => undefined).then(work);
    writes = result;
    return result;
  };
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
  server.handle(readFeature, async (input) => featureRead(await connect(), input));
  server.handle(mutateFeature, async (input) => {
    const api = await connect();
    const work = () => serialize(() => featureMutate(api, input));
    if (
      /^(?:sync\.|backup\.|agents\.upgrade|library\.(?:rtk\.|skills\.(?:install|check|update)|market\.|sync)|plugins\.(?:update|check)|usage\.export|archive\.export|update\.(?:install|check)|provider\.(?:test|detect|move|adopt)|codex\.restart)/.test(
        input.operation,
      )
    ) {
      const started = jobs.start(async () => ({ ...(await work()), notice: "操作完成。" }));
      return { data: null, jobId: started.jobId };
    }
    return { ...(await work()), jobId: "" };
  });
  server.handle(readPluginCatalog, async (input) => pluginCatalog(await connect(), input));
  server.handle(runAction, async (input) => {
    const api = await connect();
    if (["plugin.add", "plugin.upgrade", "library.skill.install"].includes(input.type))
      return jobs.start(() => serialize(() => act(api, input)));
    return { ...(await serialize(() => act(api, input))), jobId: "" };
  });
  server.handle(readJob, (input) => jobs.read(input.id));
  server.handle(signIn, async (input) => signin(await connect(), input));
  server.handle(readTranscript, async (input) => transcript(await connect(), input));
  server.handle(revealGatewayKey, async (input) => gatewaySecret(await connect(), input));
  return async () => {
    jobs.clear();
    (await api?.catch(() => undefined))?.close();
  };
}
