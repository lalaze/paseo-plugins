import { QueryObserver } from '@tanstack/react-query';
import type { ConsumptionQuery } from './consumption-query';
import { dateInZone } from '../shared/consumption';
import { backgroundConsumptionRange, consumptionTimezone } from '../shared/consumption-cache';

/** Lives with the host plugin instance, independently of any mounted page. */
export function startConsumptionSync(query: ConsumptionQuery, timezone = consumptionTimezone(), now = () => new Date()) {
  const options = () => ({ ...query.options(backgroundConsumptionRange(timezone, now())), staleTime: 60000, refetchIntervalInBackground: true });
  const observer = new QueryObserver(query.client, options());
  const unsubscribe = observer.subscribe(() => {});
  let date = dateInZone(now(), timezone), key = JSON.stringify(options().queryKey);
  const timer = setInterval(() => {
    const next = options(), nextKey = JSON.stringify(next.queryKey), nextDate = dateInZone(now(), timezone);
    if (nextKey !== key) { key = nextKey; observer.setOptions(next); }
    else if (nextDate !== date) void observer.refetch();
    date = nextDate;
  }, 30000);
  return () => { clearInterval(timer); unsubscribe(); observer.destroy(); };
}
