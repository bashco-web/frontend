'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff, ExternalLink } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useRequireAuth } from '@/lib/use-require-auth';
import { apiFetch, ApiError } from '@/lib/api';
import { signAndSubmit } from '@/lib/onchain';
import { ticketingContractUrl } from '@/lib/event-details';
import { INDUSTRY_LABELS, type Ticket } from '@/lib/types';
import { formatEventDate, maxResalePrice } from '@/lib/event-details';
import { FormError } from '@/components/form-error';
import { CopyButton } from '@/components/copy-button';
import { WalletConnectButton } from '@/components/wallet-connect-button';
import { Button } from '@/components/button';
import { StatusBadge } from '@/components/status-badge';
import { TicketQr } from '@/components/ticket-qr';

type ActiveAction = { ticketId: string; type: 'transfer' | 'resell' } | null;
type TransferRecipient = { id: string; name?: string; email?: string };

const POLL_INTERVAL_MS = 25_000;

const CONTRACT_URL = ticketingContractUrl(
  process.env.NEXT_PUBLIC_TICKETING_CONTRACT_ID,
  process.env.NEXT_PUBLIC_STELLAR_NETWORK,
);

/** Gate code is a bearer credential for entry, so it stays masked until revealed. */
function GateCode({ secret }: { secret: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <p className="mt-3 flex items-center gap-1 text-xs text-muted">
      Gate code:{' '}
      <span className="font-mono text-foreground select-all">
        {revealed ? secret : '•'.repeat(12)}
      </span>
      <button
        type="button"
        onClick={() => setRevealed((v) => !v)}
        aria-label={revealed ? 'Hide gate code' : 'Show gate code'}
        aria-pressed={revealed}
        title={revealed ? 'Hide gate code' : 'Show gate code'}
        className="inline-flex items-center rounded p-1 text-muted hover:bg-surface hover:text-foreground"
      >
        {revealed ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
      </button>
      <CopyButton value={secret} label="Copy gate code" />
    </p>
  );
}

export default function MyTicketsPage() {
  const { user, loading } = useAuth();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loadingTickets, setLoadingTickets] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyTicketId, setBusyTicketId] = useState<string | null>(null);

  const [activeAction, setActiveAction] = useState<ActiveAction>(null);
  const [transferEmail, setTransferEmail] = useState('');
  const [resalePrice, setResalePrice] = useState('');
  const [pendingTransfer, setPendingTransfer] = useState<{
    ticketId: string;
    recipient: TransferRecipient;
  } | null>(null);

  useRequireAuth();

  async function loadTickets() {
    try {
      const res = await apiFetch<Ticket[]>('/tickets/mine');
      setTickets(res);
      setLoadFailed(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your tickets.');
      setLoadFailed(true);
    }
  }

  /**
   * Refreshes the list after an on-chain action has already been confirmed.
   * Runs outside the action's try/catch so a failed reload never reports the
   * (already completed) action as failed and invites a retry (#62).
   */
  async function reloadAfterAction(doneMessage: string) {
    try {
      setTickets(await apiFetch<Ticket[]>('/tickets/mine'));
      setNotice(doneMessage);
    } catch {
      setNotice(`${doneMessage} The list could not refresh; reload the page to see the latest state.`);
    }
  }

  useEffect(() => {
    if (!user) return;
    async function run() {
      await loadTickets();
      setLoadingTickets(false);
    }
    void run();
  }, [user]);

  // Refresh while the tab is visible so check-ins and sales show up without a reload.
  useEffect(() => {
    if (!user) return;
    async function refresh() {
      if (document.visibilityState !== 'visible') return;
      try {
        setTickets(await apiFetch<Ticket[]>('/tickets/mine'));
      } catch {
        // Keep showing the last known tickets; the next poll will retry.
      }
    }
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [user]);
  async function retryLoad() {
    setError(null);
    setLoadingTickets(true);
    await loadTickets();
    setLoadingTickets(false);
  }

  function toggleAction(ticketId: string, type: 'transfer' | 'resell') {
    setActiveAction((prev) =>
      prev?.ticketId === ticketId && prev.type === type ? null : { ticketId, type },
    );
    setTransferEmail('');
    setResalePrice('');
  }

  function requireWallet(): string | null {
    if (!user?.stellarPublicKey) {
      setError('Connect your wallet before managing tickets.');
      return null;
    }
    return user.stellarPublicKey;
  }

  async function handleLookupRecipient(ticket: Ticket) {
    if (transferEmail.trim().toLowerCase() === user?.email.toLowerCase()) {
      setError('You already own this ticket.');
      return;
    }
    setError(null);
    setNotice(null);
    setBusyTicketId(ticket.id);
    try {
      const recipient = await apiFetch<TransferRecipient>(
        `/users/lookup?email=${encodeURIComponent(transferEmail)}`,
      );
      setPendingTransfer({ ticketId: ticket.id, recipient });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not find that user.');
    } finally {
      setBusyTicketId(null);
    }
  }

  async function handleTransfer(ticketId: string, recipient: TransferRecipient) {
    const wallet = requireWallet();
    if (!wallet) return;
    setError(null);
    setNotice(null);
    setBusyTicketId(ticketId);
    let doneMessage: string | null = null;
    try {
      const { unsignedXdr } = await apiFetch<{ unsignedXdr: string }>(
        `/tickets/${ticketId}/transfer`,
        { method: 'POST', body: { toUserId: recipient.id } },
      );
      await signAndSubmit(unsignedXdr, wallet, (signedXdr) =>
        apiFetch(`/tickets/${ticketId}/confirm-transfer`, {
          method: 'POST',
          body: { toUserId: recipient.id, signedXdr },
        }),
      );
      doneMessage = `Ticket transferred to ${transferEmail}.`;
      setActiveAction(null);
      setPendingTransfer(null);
      setTransferEmail('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not transfer this ticket.');
    } finally {
      setBusyTicketId(null);
    }
    if (doneMessage) await reloadAfterAction(doneMessage);
  }

  async function handleListForResale(e: FormEvent, ticketId: string) {
    e.preventDefault();
    const ticket = tickets.find((item) => item.id === ticketId);
    if (!ticket || !/^[1-9]\d*$/.test(resalePrice)) return;
    const wallet = requireWallet();
    if (!wallet) return;
    const cap = maxResalePrice(ticket.ticketType?.price, ticket.event?.maxResaleMultiplierBps);
    if (cap !== null && (!/^\d+$/.test(resalePrice) || BigInt(resalePrice) > BigInt(cap))) {
      setError(`Enter a whole-number price of at most ${cap}.`);
      return;
    }
    setError(null);
    setNotice(null);
    setBusyTicketId(ticketId);
    let doneMessage: string | null = null;
    try {
      const { unsignedXdr } = await apiFetch<{ unsignedXdr: string }>(
        `/tickets/${ticketId}/list-resale`,
        { method: 'POST', body: { price: resalePrice } },
      );
      await signAndSubmit(unsignedXdr, wallet, (signedXdr) =>
        apiFetch(`/tickets/${ticketId}/confirm-list-resale`, {
          method: 'POST',
          body: { price: resalePrice, signedXdr },
        }),
      );
      doneMessage = 'Ticket listed on the marketplace.';
      setActiveAction(null);
      setResalePrice('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not list this ticket.');
    } finally {
      setBusyTicketId(null);
    }
    if (doneMessage) await reloadAfterAction(doneMessage);
  }

  async function handleCancelResale(ticketId: string) {
    const wallet = requireWallet();
    if (!wallet) return;
    setError(null);
    setNotice(null);
    setBusyTicketId(ticketId);
    let doneMessage: string | null = null;
    try {
      const { unsignedXdr } = await apiFetch<{ unsignedXdr: string }>(
        `/tickets/${ticketId}/cancel-resale`,
        { method: 'POST' },
      );
      await signAndSubmit(unsignedXdr, wallet, (signedXdr) =>
        apiFetch(`/tickets/${ticketId}/confirm-cancel-resale`, {
          method: 'POST',
          body: { signedXdr },
        }),
      );
      doneMessage = 'Listing cancelled.';
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel this listing.');
    } finally {
      setBusyTicketId(null);
    }
    if (doneMessage) await reloadAfterAction(doneMessage);
  }

  if (loading || !user) return null;

  const isValidResalePrice = /^[1-9]\d*$/.test(resalePrice);

  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="font-heading text-3xl font-bold">My tickets</h1>
      <div className="mt-4">
        <WalletConnectButton />
      </div>

      {error && (
        <div className="mt-6">
          <FormError message={error} />
        </div>
      )}
      {notice && <p className="mt-6 text-sm text-gradient font-medium">{notice}</p>}

      {loadingTickets ? (
        <p className="mt-8 text-muted">Loading…</p>
      ) : loadFailed && tickets.length === 0 ? (
        <div className="mt-8">
          <Button onClick={retryLoad} variant="secondary" size="sm">
            Retry
          </Button>
        </div>
      ) : tickets.length === 0 ? (
        <p className="mt-8 text-muted">You don’t have any tickets yet.</p>
      ) : (
        <ul className="mt-8 flex flex-col gap-4">
          {tickets.map((ticket) => (
            <li key={ticket.id} className="rounded-lg border border-border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">{ticket.event?.name}</p>
                  <p className="text-sm text-muted">
                    {ticket.ticketType?.name} · Seat {ticket.seat}
                  </p>
                  {ticket.event && (
                    <p className="text-sm text-muted">
                      {formatEventDate(ticket.event.startsAt)} · {ticket.event.venue} ·{' '}
                      {INDUSTRY_LABELS[ticket.event.category]}
                    </p>
                  )}
                </div>
                <StatusBadge status={ticket.status} />
              </div>

              <GateCode secret={ticket.qrSecret} />

              {CONTRACT_URL && (
                <a
                  href={CONTRACT_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-flex items-center gap-1 text-xs text-gradient font-medium hover:underline"
                >
                  View on-chain (ticket #{ticket.chainTicketId})
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              )}
              {ticket.status === 'VALID' ? (
                <div className="mt-3">
                  <TicketQr value={ticket.qrSecret} />
                  <p className="mt-2 flex items-center gap-1 text-xs text-muted">
                    Gate code:{' '}
                    <span className="font-mono text-foreground select-all">{ticket.qrSecret}</span>
                    <CopyButton value={ticket.qrSecret} label="Copy gate code" />
                  </p>
                </div>
              ) : (
                <p className="mt-3 text-xs text-muted">
                  {ticket.status === 'RESALE'
                    ? 'The gate code is hidden while this ticket is listed for resale.'
                    : 'The gate code is no longer valid for this ticket.'}
                </p>
              )}

              {ticket.status === 'VALID' && (
                <div className="mt-3 flex gap-3">
                  <button
                    onClick={() => toggleAction(ticket.id, 'transfer')}
                    className="text-sm text-gradient font-medium hover:underline"
                  >
                    Transfer
                  </button>
                  <button
                    onClick={() => toggleAction(ticket.id, 'resell')}
                    className="text-sm text-gradient font-medium hover:underline"
                  >
                    List for resale
                  </button>
                </div>
              )}
              {ticket.status === 'RESALE' && (
                <button
                  onClick={() => handleCancelResale(ticket.id)}
                  disabled={busyTicketId === ticket.id}
                  className="mt-3 text-sm text-gradient font-medium hover:underline disabled:opacity-50"
                >
                  {busyTicketId === ticket.id ? 'Working…' : 'Cancel listing'}
                </button>
              )}

              {activeAction?.ticketId === ticket.id && activeAction.type === 'transfer' && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    void handleLookupRecipient(ticket)
                  }}
                  className="mt-3 flex gap-2"
                >
                  <label htmlFor={`transfer-email-${ticket.id}`} className="sr-only">
                    Recipient email
                  </label>
                  <input
                    id={`transfer-email-${ticket.id}`}
                    type="email"
                    required
                    placeholder="recipient@example.com"
                    value={transferEmail}
                    onChange={(e) => {
                      setTransferEmail(e.target.value);
                      setPendingTransfer(null);
                    }}
                    className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm"
                  />
                  <Button
                    type="submit"
                    onClick={() => handleLookupRecipient(ticket)}
                    loading={busyTicketId === ticket.id && pendingTransfer === null}
                    size="sm"
                  >
                    Send
                  </Button>
                </form>
              )}
              {pendingTransfer?.ticketId === ticket.id && (
                <div className="mt-3 flex items-center justify-between gap-2 text-sm">
                  <p>
                    Transfer <span className="font-medium">{ticket.event?.name}</span> to{' '}
                    {pendingTransfer.recipient.name
                      ? `${pendingTransfer.recipient.name} (${transferEmail})`
                      : transferEmail}
                    ?
                  </p>
                  <Button
                    onClick={() => handleTransfer(ticket.id, pendingTransfer.recipient)}
                    loading={busyTicketId === ticket.id}
                    size="sm"
                  >
                    {busyTicketId === ticket.id ? 'Sending…' : 'Confirm'}
                  </Button>
                </div>
              )}
              {activeAction?.ticketId === ticket.id && activeAction.type === 'resell' && (
                <form
                  onSubmit={(e) => handleListForResale(e, ticket.id)}
                  className="mt-3 flex gap-2"
                >
                  <label htmlFor={`resale-price-${ticket.id}`} className="sr-only">
                    Asking price
                  </label>
                  <input
                    id={`resale-price-${ticket.id}`}
                    inputMode="numeric"
                    required
                    placeholder="Asking price"
                    value={resalePrice}
                    onChange={(e) => setResalePrice(e.target.value)}
                    aria-invalid={resalePrice !== '' && !isValidResalePrice}
                    className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm"
                  />
                  <Button
                    type="submit"
                    loading={busyTicketId === ticket.id}
                    disabled={!isValidResalePrice}
                    size="sm"
                  >
                    {busyTicketId === ticket.id ? 'Listing…' : 'List'}
                  </Button>
                  {maxResalePrice(ticket.ticketType?.price, ticket.event?.maxResaleMultiplierBps) !==
                    null && (
                    <p className="w-full text-xs text-muted">
                      Max resale price:{' '}
                      {maxResalePrice(ticket.ticketType?.price, ticket.event?.maxResaleMultiplierBps)}
                    </p>
                  )}
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
