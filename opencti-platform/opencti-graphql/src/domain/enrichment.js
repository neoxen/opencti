import { Promise } from 'bluebird';
import { map } from 'ramda';
import { connectorsFor } from './connector';
import { createWork } from './work';
import { pushToConnector } from '../database/rabbitmq';
import { ABSTRACT_STIX_CYBER_OBSERVABLE } from '../schema/general';

export const CONNECTOR_INTERNAL_ENRICHMENT = 'INTERNAL_ENRICHMENT'; // Entity types to support (Report, Hash, ...) -> enrich-

export const connectorsForEnrichment = async (scope, onlyAlive = false, onlyAuto = false) =>
  connectorsFor(CONNECTOR_INTERNAL_ENRICHMENT, scope, onlyAlive, onlyAuto);

export const askEnrich = async (observableId, scope) => {
  // Get the list of compatible connectors
  const targetConnectors = await connectorsForEnrichment(scope, true, true);
  // Create a work for each connector
  const workList = await Promise.all(
    map((connector) => {
      return createWork(connector, ABSTRACT_STIX_CYBER_OBSERVABLE, observableId).then(({ job, work }) => {
        return { connector, job, work };
      });
    }, targetConnectors)
  );
  // Send message to all correct connectors queues
  await Promise.all(
    map((data) => {
      const { connector, work, job } = data;
      const message = { work_id: work.internal_id, job_id: job.internal_id, entity_id: observableId };
      return pushToConnector(connector, message);
    }, workList)
  );
  return workList;
};
