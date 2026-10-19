import { ghlRequest, type GhlRequestTarget } from './client';

export interface UpsertContactInput {
  email: string;
  name?: string;
  locationId: string;
  /** Kept so team members are distinguishable from leads in the CRM. */
  source?: string;
}

/**
 * Find-or-create a contact by email, returning its id.
 *
 * The Conversations email endpoint requires a `contactId`, so this is unavoidable — and because
 * invites go to teammates, they do end up in the CRM. `source` marks them as such.
 */
export async function upsertContactByEmail(conn: GhlRequestTarget, input: UpsertContactInput): Promise<string> {
  const res = await ghlRequest<{ contact?: { id?: string } }>(conn, {
    method: 'POST',
    url: '/contacts/upsert',
    data: {
      email: input.email,
      name: input.name,
      locationId: input.locationId,
      source: input.source,
    },
  });

  const id = res?.contact?.id;
  if (!id) throw new Error('GHL contact upsert returned no contact id');
  return id;
}

export interface SendEmailInput {
  contactId: string;
  subject: string;
  html: string;
  /** Plain-text alternative; GHL stores it alongside the HTML. */
  text?: string;
  emailFrom?: string;
}

export interface SendEmailResult {
  messageId?: string;
  conversationId?: string;
}

/**
 * Send an email through the Conversations API.
 *
 * `type` and `contactId` are the only required fields per GHL's reference. Note the docs render the
 * v3 schema, which also lists `status` as required; on the `2021-07-28` version this project sends,
 * it is not, so it is omitted — if GHL ever answers 400 complaining about a missing field, that is
 * the first one to look at.
 */
export async function sendEmailMessage(conn: GhlRequestTarget, input: SendEmailInput): Promise<SendEmailResult> {
  const data: Record<string, unknown> = {
    type: 'Email',
    contactId: input.contactId,
    subject: input.subject,
    html: input.html,
  };
  if (input.text) data.message = input.text;
  if (input.emailFrom) data.emailFrom = input.emailFrom;

  const res = await ghlRequest<SendEmailResult>(conn, {
    method: 'POST',
    url: '/conversations/messages',
    data,
  });

  return { messageId: res?.messageId, conversationId: res?.conversationId };
}
