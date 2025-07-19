export default class {
  static token: string;
  static cookie: Record<string,string> = {};
  static async post(channel: 'ADT_HOME_APP_SERVICE' | 'ADT_HOME_NATIVE', service: string, body: object = {}, options: {
    no_auth?: boolean,
    no_cookie?: boolean
  } = {}) {
    const fetch_options = {
      "headers": {
        "accept": "application/json, text/javascript, */*",
        "content-type": "application/json;charset=UTF-8",
        "Referer": "https://adtcapshome.co.kr:8443/home2/device/dash"
      },
      "body": JSON.stringify({
        "common": {},
        "header": {
          "CHANNEL": channel
        },
        "body": {
          "request": body,
          "response": {}
        },
        "tail": {}
      }),
      "method": "POST"
    };
    if(!options.no_auth && this.token) {
      fetch_options.headers['Authorization'] = `Bearer ${this.token}`;
    }
    if(!options.no_cookie && Object.keys(this.cookie).length>0) {
      fetch_options.headers['Cookie'] = Object.entries(this.cookie).map(([k,v])=>`${k}=${v}`).join('; ');
    }
    const resp = await fetch(`https://adtcapshome.co.kr:8443/transaction/${channel}.${service}`, fetch_options);
    if(!resp.ok) {
      throw new Error(`HTTP request failed with status ${resp.status}`);
    }
    const resp_cookies = resp.headers.getSetCookie();
    if(resp_cookies?.length>0) {
      for(const row of resp_cookies) {
        const [name, value] = row.split(';')[0].split('=');
        this.cookie[name] = value;
      }
    }
    const resp_body = await resp.json();
    if(resp_body.common.FRAMEWORK_SUCCESS !== 'Y') {
      if(typeof resp_body.body.response.errCode === 'string') {
        throw new Error(`ADT error: ${resp_body.body.response.errCode}:${resp_body.body.response.errHelpMessage}`);
      }
      if(resp_body.header.RESULT_TYPE === 'ERROR') {
        throw new Error(`ADT error: ${resp_body.header.RESULT_MSG}`);
      }
      throw new Error(`Unknown server error: ${JSON.stringify(resp_body)}`);
    }
    if(!resp_body.body.response) {
      throw new Error(`Not an error but no response body: ${JSON.stringify(resp_body)}`);
    }
    return resp_body.body.response;
  }
}
