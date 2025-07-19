import MQTT from 'mqtt';
import * as PathToRegexp from 'path-to-regexp';
import ADTCapsHome from '../lib/adtcapshome.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const topic_prefix = process.env.MQTT_TOPIC_PREFIX || 'adtcapshome';
const discovery_prefix = process.env.MQTT_DISCOVERY_PREFIX || 'homeassistant';
const state: {
  signal?: string
} = {};

const state_replace = {
  'SECURITY_ON': 'armed_away',
  'SECURITY_OFF': 'disarmed',
  'SENSOR_OPEN': 'ON',
  'SENSOR_CLOSE': 'OFF',
};

process.on('SIGINT', () => {
  state.signal = 'SIGINT';
});

process.on('SIGTERM', () => {
  state.signal = 'SIGTERM';
});

process.on('SIGQUIT', () => {
  state.signal = 'SIGQUIT';
});

(async ()=>{
  if(!process.env.MQTT_URL) {
    throw new TypeError('MQTT_URL is not defined');
  }
  const conn = await MQTT.connectAsync(process.env.MQTT_URL);
  const availability_topics: string[] = [];
  const pending_states: Record<string, string | null> = {};
  const routes = {
    '/:device_id/set': async ({params:[device_id], message}: {params: string[], message: string}) => {
      if(message.startsWith('ARM_')) {
        await ADTCapsHome.post('ADT_HOME_APP_SERVICE', 'remoPartitionService/state', {device_id, request_state: "1"});
        pending_states[`${device_id}/state`] = 'SECURITY_ON';
        setTimeout(() => {
          pending_states[`${device_id}/state`] = null;
        }, 5000);
        await conn.publishAsync(`${topic_prefix}/${device_id}/state`, 'arming', {qos: 1});
      }
      if(message === 'DISARM') {
        await ADTCapsHome.post('ADT_HOME_APP_SERVICE', 'remoPartitionService/state', {device_id, request_state: "0"});
        pending_states[`${device_id}/state`] = 'SECURITY_OFF';
        setTimeout(() => {
          pending_states[`${device_id}/state`] = null;
        }, 5000);
        await conn.publishAsync(`${topic_prefix}/${device_id}/state`, 'disarming', {qos: 1});
      }
    },
  };

  const account = await ADTCapsHome.post('ADT_HOME_APP_SERVICE', 'HomeLoginService', {
    "login_type": "T",
    "auth_token": "7613b935-e14c-40d6-9e3a-047bbc147b84",
    "app_uid": "",
  });
  const device_info: Record<string,any> = {};
  const contract_id = account.user_info.selected_contract_no;

  {
    const paths = Object.entries(routes).map(([path, handler]) => [PathToRegexp.pathToRegexp(path) as any, handler]);
    conn.on('message', async (topic, message)=>{
      for(const path of paths) {
        const match = path[0].regexp.exec(topic.substring(topic_prefix.length + 1 + contract_id.length));
        if(match) {
          path[1]({
            params: match.slice(1),
            message: message.toString(),
          })
          break;
        }
      }
    });
  }

  await conn.publishAsync(`${topic_prefix}/${contract_id}/availability`, 'online', {qos: 1});
  availability_topics.push(`${topic_prefix}/${contract_id}/availability`);

  const set_state = async (topic: string, state: string) => {
    if(pending_states[topic]) {
      if(state !== pending_states[topic]) {
        return;
      }
      pending_states[topic] = null;
    }
    return await conn.publishAsync(`${topic_prefix}/${contract_id}/${topic}`, state_replace[state]||state, {qos: 1});
  };
  const prev_cam_state = {};
  const update_cam = async () => {
    const r = await ADTCapsHome.post('ADT_HOME_APP_SERVICE', 'remoDoorcamService/getMainMovieListDynamo', {
      "isFirst": "false",
      "selActivityIdList": "/##DOORVIEW_INVADER/##,/##DOORVIEW_RECORD/##,/##DOORVIEW_PROWL/##",
      "dim": true,
      "lines": 20,
      "device_type": "DOORCAM"
    });
    const current_cam_state = {};
    for(const item of r.list) {
      if(current_cam_state[item.device_id]) continue;
      current_cam_state[item.device_id] = item;
    }

    for(const device_id of Object.keys(current_cam_state)) {
      const state = current_cam_state[device_id];
      if(prev_cam_state[device_id]?.noti_id === state.noti_id) continue;

      await set_state(`${device_id}/camera`, JSON.stringify(state));
      await set_state(`${device_id}/camera_url`, state.thumb_path_url);
      await conn.publishAsync(`${topic_prefix}/${contract_id}/${device_id}/camera_thumb`, Buffer.from(await (await fetch(state.thumb_path_url)).arrayBuffer()), {qos: 1, retain: true, properties: {contentType: 'image/jpeg'}});
      prev_cam_state[device_id] = state;

      await conn.publishAsync(`${discovery_prefix}/image/${contract_id}/${device_id}/config`, JSON.stringify({
        "availability_topic": `${topic_prefix}/${contract_id}/${device_id}/availability`,
        "device": device_info,
        "json_attributes_topic": `${topic_prefix}/${contract_id}/${device_id}/camera`,
        "name": `${devices[device_id].user_device_name} Camera`,
        "object_id": `${devices[device_id].device_type} ${device_id} Camera`,
        "qos": 1,
        "image_topic": `${topic_prefix}/${contract_id}/${device_id}/camera_thumb`,
        "unique_id": `${device_id}_image`,
      }));
    }
  };
  const update_acp = async () => {
    const devices: Record<string,any> = {};
    const r = await ADTCapsHome.post('ADT_HOME_APP_SERVICE', 'DashBoardService', {});
    for(const space of r.space) {
      for(const device of space.deviceList) {
        devices[device.device_id] = device;
        await conn.publishAsync(`${topic_prefix}/${contract_id}/${device.device_id}/availability`, device.mas_connection === 'DEVICE_CONNECT' ? 'online' : 'offline', {qos: 1});
        availability_topics.push(`${topic_prefix}/${contract_id}/${device.device_id}/availability`);
      }
      for(const partition of space.partition) {
        await set_state(`${partition.device_id}/state`, partition.partition_status);
      }
      for(const sensor of space.sensor) {
        await set_state(`${sensor.device_id}/sensor_state`, sensor.zone_status);
      }

      if(devices[space.product.device_id]) {
        Object.assign(device_info, {
          'connections': [
            ['mac', devices[space.product.device_id].device_sn],
          ],
          identifiers: [
            devices[space.product.device_id].device_id,
            devices[space.product.device_id].device_sn,
          ],
          manufacturer: 'SK SHIELDUS',
          model: devices[space.product.device_id].model_no,
          model_id: devices[space.product.device_id].device_model_id,
          name: devices[space.product.device_id].user_device_name,
          serial_number: devices[space.product.device_id].device_sn,
        });

        await conn.publishAsync(`${discovery_prefix}/alarm_control_panel/${contract_id}/${space.product.device_id}/config`, JSON.stringify({
          "availability_topic": `${topic_prefix}/${contract_id}/${space.product.device_id}/availability`,
          "code_arm_required": false,
          "code_disarm_required": false,
          "command_topic": `${topic_prefix}/${contract_id}/${space.product.device_id}/set`,
          "device": device_info,
          "name": `${devices[space.product.device_id].user_device_name} Alarm Control Panel`,
          "object_id": `${devices[space.product.device_id].device_type} ${space.product.device_id} Alarm Control Panel`,
          "platform": "alarm_control_panel",
          "qos": 1,
          "state_topic": `${topic_prefix}/${contract_id}/${space.product.device_id}/state`,
          "supported_features": ["arm_away"],
          "unique_id": `${space.product.device_id}_acp`,
        }));

        await conn.publishAsync(`${discovery_prefix}/binary_sensor/${contract_id}/${space.product.device_id}/config`, JSON.stringify({
          "availability_topic": `${topic_prefix}/${contract_id}/${space.product.device_id}/availability`,
          "device": device_info,
          "device_class": "door",
          "name": `${devices[space.product.device_id].user_device_name} Door Sensor`,
          "object_id": `${devices[space.product.device_id].device_type} ${space.product.device_id} Door Sensor`,
          "platform": "binary_sensor",
          "qos": 1,
          "state_topic": `${topic_prefix}/${contract_id}/${space.product.device_id}/sensor_state`,
          "unique_id": `${space.product.device_id}_door_sensor`,
        }));
      }
    }
    return devices;
  };

  const devices = await update_acp();
  for(const device of Object.values(devices)){
    if(device.device_type !== 'DOORCAM') continue;
    await conn.subscribeAsync(`${topic_prefix}/${contract_id}/${device.device_id}/set`, {qos: 1});
  }

  while(1) {
    if(state.signal && ['SIGINT', 'SIGTERM', 'SIGQUIT'].includes(state.signal)) {
      console.error('Signal received, exiting...');
      break;
    }

    await update_acp();
    await update_cam();
    await sleep(1000);
  }

  for(const topic of availability_topics) {
    await conn.publishAsync(topic, 'offline', {qos: 1});
  }

  return 0;
})().then(process.exit, err=>{
  console.error(err);
  process.exit(1);
});
