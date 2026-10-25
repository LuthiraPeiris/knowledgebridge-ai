// KnowledgeBridge AI — AWS Lambda handler
//
// Retrieves business knowledge from a single JSON document in a private Amazon S3
// bucket and returns a structured response for an n8n AI Agent tool to consume.
//
// Runtime: Node.js 22.x (the runtime bundles AWS SDK v3, so we don't ship node_modules).
// Invoked via the Lambda Invoke API (n8n AWS Lambda node, AWS_IAM auth). No Function URL.
//
// Required environment variables:
//   BUCKET_NAME  — S3 bucket holding the knowledge document
//   OBJECT_KEY   — S3 object key of the knowledge document (e.g. business-knowledge.json)
// AWS_REGION is provided automatically by the Lambda runtime.

let cachedS3Client = null;
let cachedGetObjectCommand = null;

/**
 * Lazily loads the AWS SDK v3 client and command.
 * Reuses the S3 client across warm invocations (Lambda container reuse).
 * Lazy dynamic import allows the module to be loaded and unit-tested in local
 * environments without requiring external dependencies to be installed.
 */
async function getS3Resources(region) {
  if (!cachedS3Client) {
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
    cachedS3Client = new S3Client({ region });
    cachedGetObjectCommand = GetObjectCommand;
  }
  return { s3Client: cachedS3Client, GetObjectCommand: cachedGetObjectCommand };
}

// Topic must be 1–64 chars of [A-Za-z0-9_-]. Rejects anything else early so we
// never pass attacker-controlled strings into downstream logic.
const TOPIC_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Pulls the requested topic out of the incoming event. Supports the shapes that
 * n8n's AWS Lambda node, API Gateway, and Function URLs produce.
 * Returns null when no usable topic was supplied (treated as "return all").
 */
export function extractTopic(event) {
  if (!event) return null;
  let parsedEvent = event;
  if (typeof event === 'string') {
    try {
      parsedEvent = JSON.parse(event);
    } catch {
      return null;
    }
  }
  if (!parsedEvent || typeof parsedEvent !== 'object') return null;

  let raw = null;
  if (typeof parsedEvent.topic === 'string') {
    raw = parsedEvent.topic;
  } else if (parsedEvent.Input && typeof parsedEvent.Input.topic === 'string') {
    raw = parsedEvent.Input.topic;
  } else if (parsedEvent.queryStringParameters && typeof parsedEvent.queryStringParameters.topic === 'string') {
    raw = parsedEvent.queryStringParameters.topic;
  } else if (typeof parsedEvent.body === 'string') {
    try {
      const body = JSON.parse(parsedEvent.body);
      if (body && typeof body.topic === 'string') raw = body.topic;
    } catch {
      // Body wasn't valid JSON — ignore, treat as no topic.
    }
  } else if (parsedEvent.body && typeof parsedEvent.body === 'object' && typeof parsedEvent.body.topic === 'string') {
    raw = parsedEvent.body.topic;
  } else if (parsedEvent.payload && typeof parsedEvent.payload === 'object' && typeof parsedEvent.payload.topic === 'string') {
    raw = parsedEvent.payload.topic;
  }

  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Builds the structured response object returned to the caller. We return a
 * plain JSON object (not an HTTP-style {statusCode, body} envelope) because the
 * n8n AWS Lambda node consumes the Invoke response payload directly, and the
 * AI Agent reads the fields straight off the result.
 */
export function buildResult({ status, message, source, requestedTopic, content, error = null, requestId }) {
  const result = {
    status,
    message,
    source,
    requestedTopic,
    content,
    requestId,
  };
  if (error !== null) result.error = error;
  return result;
}

export const handler = async (event, context, injectedClient) => {
  const requestId = (context && context.awsRequestId)
    || `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const region = process.env.AWS_REGION || 'ap-south-1';
  const bucketName = process.env.BUCKET_NAME;
  const objectKey = process.env.OBJECT_KEY;

  // 1. Validate configuration (fail closed — never log secrets, only flag the missing var).
  if (!bucketName || !objectKey) {
    console.error('Configuration error: BUCKET_NAME or OBJECT_KEY is not set.');
    return buildResult({
      status: 'misconfigured',
      message: 'Lambda is missing required S3 configuration.',
      source: null,
      requestedTopic: null,
      content: null,
      error: 'Set the BUCKET_NAME and OBJECT_KEY environment variables on the Lambda function.',
      requestId,
    });
  }

  // 2. Extract and validate the requested topic.
  const requestedTopic = extractTopic(event);
  if (requestedTopic !== null && !TOPIC_REGEX.test(requestedTopic)) {
    // Sanitize any reflected input to prevent prompt injection into LLM context.
    const safeTopicSnippet = requestedTopic
      .slice(0, 64)
      .replace(/[\r\n\t]/g, ' ')
      .trim();

    return buildResult({
      status: 'invalid_input',
      message: `Invalid topic '${safeTopicSnippet}'. Topic must be 1–64 characters of letters, digits, hyphens, or underscores.`,
      source: null,
      requestedTopic: safeTopicSnippet,
      content: null,
      error: 'Topic failed validation.',
      requestId,
    });
  }

  // 3. Fetch and parse the knowledge document from S3.
  let knowledge;
  try {
    // Use the injected S3 client ONLY when it has a callable `.send` method.
    // AWS Lambda passes a callback function as the third handler argument — a
    // function has no `.send` method, so this check safely ignores it in
    // production and falls back to the real AWS SDK S3 client. In unit tests,
    // the caller passes a mock client with a `.send` method, which we use here.
    // This is what prevents the `client.send is not a function` runtime error
    // that occurs if the Lambda callback is mistaken for an S3 client.
    let client;
    let CommandClass = null;

    if (injectedClient && typeof injectedClient.send === 'function') {
      client = injectedClient;
    } else {
      const s3Res = await getS3Resources(region);
      client = s3Res.s3Client;
      CommandClass = s3Res.GetObjectCommand;
    }

    const command = CommandClass
      ? new CommandClass({ Bucket: bucketName, Key: objectKey })
      : { Bucket: bucketName, Key: objectKey };

    const response = await client.send(command);
    const bodyString = typeof response.Body?.transformToString === 'function'
      ? await response.Body.transformToString('utf-8')
      : String(response.Body);

    knowledge = JSON.parse(bodyString);

    if (!knowledge || typeof knowledge !== 'object' || Array.isArray(knowledge)) {
      throw new Error('S3 object content is not a valid JSON object.');
    }
  } catch (err) {
    console.error('S3 retrieval or JSON parse failed:', err.name || 'Error', err.message);
    return buildResult({
      status: 'retrieval_failed',
      message: 'Could not retrieve or parse the knowledge document from S3.',
      source: {
        type: 'AmazonS3',
        bucket: bucketName,
        key: objectKey,
        region,
      },
      requestedTopic,
      content: null,
      error: `${err.name || 'Error'}: ${err.message || 'unknown error'}`,
      requestId,
    });
  }

  // 4. Build the source metadata that the AI Agent will cite.
  const source = {
    type: 'AmazonS3',
    bucket: bucketName,
    key: objectKey,
    region,
    retrievedAt: new Date().toISOString(),
  };

  // 5. If a topic was requested, match against top-level keys.
  // First attempt an exact match, then fall back to case-insensitive and normalized matching.
  let matchedKey = null;
  if (requestedTopic) {
    if (Object.prototype.hasOwnProperty.call(knowledge, requestedTopic)) {
      matchedKey = requestedTopic;
    } else {
      const normalizedTopic = requestedTopic.toLowerCase().replace(/[-_]/g, '');
      const candidate = Object.keys(knowledge).find(
        (key) => key.toLowerCase().replace(/[-_]/g, '') === normalizedTopic
      );
      if (candidate) {
        matchedKey = candidate;
      }
    }
  }

  if (matchedKey) {
    return buildResult({
      status: 'ok',
      message: `Retrieved business knowledge for topic '${matchedKey}' from S3.`,
      source,
      requestedTopic,
      content: { [matchedKey]: knowledge[matchedKey] },
      requestId,
    });
  }

  // 6. No topic, or topic not present — return the whole document with a clear note
  // so the AI Agent can still answer (or surface that the topic wasn't found).
  return buildResult({
    status: requestedTopic ? 'topic_not_found' : 'ok',
    message: requestedTopic
      ? `Topic '${requestedTopic}' is not a key in the knowledge document. Returning the full knowledge base so the agent can still answer.`
      : 'Retrieved the full business knowledge document from S3.',
    source,
    requestedTopic,
    content: knowledge,
    requestId,
  });
};
