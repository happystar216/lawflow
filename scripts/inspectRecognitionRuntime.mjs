// Read-only operational diagnostics. Never print env_vars, headers or API keys.
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error('Cloudflare deployment credentials are missing');
async function get(path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000)
  });
  const value = await response.json();
  return { status: response.status, success: value.success, result: value.result,
    errors: value.errors?.map(e => ({ code: e.code, message: e.message })) };
}
const [settings, project, subscriptions] = await Promise.all([
  get('workers/account-settings'), get('pages/projects/lawflow'), get('subscriptions')
]);
console.log(JSON.stringify({
  accountSettings: { status: settings.status, success: settings.success,
    defaultUsageModel: settings.result?.default_usage_model, errors: settings.errors },
  production: { status: project.status, success: project.success, errors: project.errors,
    limits: project.result?.deployment_configs?.production?.limits,
    usageModel: project.result?.deployment_configs?.production?.usage_model,
    latestDeployment: project.result?.canonical_deployment?.id },
  plans: { status: subscriptions.status, success: subscriptions.success, errors: subscriptions.errors,
    subscriptions: Array.isArray(subscriptions.result) ? subscriptions.result.map(s => ({
      name: s.rate_plan?.public_name, id: s.rate_plan?.id, state: s.state })) : [] }
}, null, 2));
