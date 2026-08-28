export async function onRequestPost(context: any) {
  const { request } = context;
  const ecsUrl = 'http://114.55.73.208/api/parse-bank-statement';

  try {
    const ecsResp = await fetch(ecsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': request.headers.get('Content-Type') || 'multipart/form-data'
      },
      body: request.body
    });

    const responseBody = await ecsResp.text();
    return new Response(responseBody, {
      status: ecsResp.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*'
      }
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: `无法连接阿里云 ECS 服务器: ${err.message}` }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    }
  });
}
