export async function onRequestPost(context: any) {
  const { request } = context;
  const tunnelUrl = 'https://registered-armor-lbs-married.trycloudflare.com/api/parse-bank-statement-stream';

  try {
    const ecsResp = await fetch(tunnelUrl, {
      method: 'POST',
      headers: {
        'Content-Type': request.headers.get('Content-Type') || 'multipart/form-data'
      },
      body: request.body
    });

    return new Response(ecsResp.body, {
      status: ecsResp.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*'
      }
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: `流式网关连接异常: ${err.message}` }),
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
