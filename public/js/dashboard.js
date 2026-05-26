const socket = io();
const dashboardBootstrap = document.getElementById("dashboard-bootstrap");
const tableBody = document.getElementById("ticketTableBody");
const historyBody = document.getElementById("ticketHistoryBody");
const ticketCountLabel = document.getElementById("ticketCountLabel");
const historyTicketCountLabel = document.getElementById("historyTicketCountLabel");
const openTicketCount = document.getElementById("openTicketCount");
const toastStack = document.getElementById("toastStack");
const enableNotificationsButton = document.getElementById("enableNotificationsButton");
const ticketDetailsModal = document.getElementById("ticketDetailsModal");
const closeTicketDetailsButton = document.getElementById("closeTicketDetailsButton");
const detailActions = document.getElementById("detailActions");
const deleteTicketFromDetailsButton = document.getElementById("deleteTicketFromDetailsButton");
const resolveConfirmModal = document.getElementById("resolveConfirmModal");
const resolveConfirmCopy = document.getElementById("resolveConfirmCopy");
const cancelResolveTopButton = document.getElementById("cancelResolveTopButton");
const cancelResolveButton = document.getElementById("cancelResolveButton");
const confirmResolveButton = document.getElementById("confirmResolveButton");
const deleteConfirmModal = document.getElementById("deleteConfirmModal");
const deleteConfirmCopy = document.getElementById("deleteConfirmCopy");
const cancelDeleteTopButton = document.getElementById("cancelDeleteTopButton");
const cancelDeleteButton = document.getElementById("cancelDeleteButton");
const confirmDeleteButton = document.getElementById("confirmDeleteButton");
const csrfToken =
  dashboardBootstrap?.dataset.csrfToken ||
  document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ||
  "";
const canDeleteTickets = dashboardBootstrap?.dataset.canDeleteTickets === "true";

let tickets = [];

if (dashboardBootstrap?.textContent?.trim()) {
  try {
    const parsedTickets = JSON.parse(dashboardBootstrap.textContent);
    tickets = Array.isArray(parsedTickets) ? parsedTickets : [];
  } catch (_error) {
    tickets = [];
  }
}
let pendingResolution = null;
let pendingDeletion = null;
let currentDetailsSource = "queue";

function formatDate(value) {
  return new Date(value).toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getActiveTickets() {
  return tickets.filter((ticket) => ticket.status !== "resolved");
}

function getResolvedTickets() {
  return tickets
    .filter((ticket) => ticket.status === "resolved")
    .sort((left, right) => new Date(right.updatedAt || right.createdAt) - new Date(left.updatedAt || left.createdAt));
}

function renderQueueRows() {
  const activeTickets = getActiveTickets();

  if (!activeTickets.length) {
    tableBody.innerHTML =
      '<tr><td colspan="8" class="empty-state">No active tickets in the queue right now.</td></tr>';
  } else {
    tableBody.innerHTML = activeTickets
      .map(
        (ticket) => `
          <tr data-ticket-id="${escapeHtml(ticket.id)}">
            <td><strong>${escapeHtml(ticket.id)}</strong></td>
            <td>
              <div>${escapeHtml(ticket.name)}</div>
              <small>${escapeHtml(ticket.email)}</small>
            </td>
            <td>
              <div>${escapeHtml(ticket.subject)}</div>
              <small>${escapeHtml(ticket.message)}</small>
            </td>
            <td><span class="badge badge-muted">${escapeHtml(ticket.category)}</span></td>
            <td><span class="badge badge-priority-${escapeHtml(ticket.priority)}">${escapeHtml(ticket.priority)}</span></td>
            <td>
              <select class="status-select" data-ticket-id="${escapeHtml(ticket.id)}" data-current-status="${escapeHtml(ticket.status)}">
                <option value="new" ${ticket.status === "new" ? "selected" : ""}>New</option>
                <option value="in_progress" ${ticket.status === "in_progress" ? "selected" : ""}>In Progress</option>
                <option value="resolved">Resolved</option>
              </select>
            </td>
            <td>${formatDate(ticket.createdAt)}</td>
            <td>
              <button class="button button-inline view-details-button" type="button" data-ticket-id="${escapeHtml(ticket.id)}">
                View Details
              </button>
            </td>
          </tr>
        `
      )
      .join("");
  }
}

function renderHistoryRows() {
  const resolvedTickets = getResolvedTickets();

  if (!resolvedTickets.length) {
    historyBody.innerHTML =
      '<tr><td colspan="5" class="empty-state">Resolved tickets will appear here after confirmation.</td></tr>';
  } else {
    historyBody.innerHTML = resolvedTickets
      .map(
        (ticket) => `
          <tr data-ticket-id="${escapeHtml(ticket.id)}">
            <td><strong>${escapeHtml(ticket.id)}</strong></td>
            <td>
              <div>${escapeHtml(ticket.name)}</div>
              <small>${escapeHtml(ticket.email)}</small>
            </td>
            <td>
              <div>${escapeHtml(ticket.subject)}</div>
              <small>${escapeHtml(ticket.message)}</small>
            </td>
            <td>
              <span class="badge badge-resolved">Resolved</span>
              <small>${formatDate(ticket.updatedAt || ticket.createdAt)}</small>
            </td>
            <td>
              <button class="button button-inline view-details-button" type="button" data-ticket-id="${escapeHtml(ticket.id)}">
                View Details
              </button>
            </td>
          </tr>
        `
      )
      .join("");
  }
}

function renderRows() {
  renderQueueRows();
  renderHistoryRows();

  ticketCountLabel.textContent = `${getActiveTickets().length} active`;
  historyTicketCountLabel.textContent = `${getResolvedTickets().length} resolved`;
  openTicketCount.textContent = getActiveTickets().length;
}

function showToast(title, message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `<strong>${escapeHtml(title)}</strong><p>${escapeHtml(message)}</p>`;
  toastStack.prepend(toast);
  window.setTimeout(() => toast.remove(), 5000);
}

function maybeNotify(ticket) {
  if (Notification.permission === "granted") {
    new Notification(`New ticket: ${ticket.subject}`, {
      body: `${ticket.name} - ${ticket.priority.toUpperCase()} priority`,
    });
  }
}

function upsertTicket(ticket) {
  const index = tickets.findIndex((entry) => entry.id === ticket.id);
  if (index === -1) {
    tickets.unshift(ticket);
  } else {
    tickets[index] = ticket;
  }

  renderRows();
}

function removeTicket(ticketId) {
  tickets = tickets.filter((ticket) => ticket.id !== ticketId);
  renderRows();
}

function formatStatus(value) {
  return String(value || "-").replaceAll("_", " ");
}

function setDetailValue(id, value) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = value || "-";
  }
}

function syncBodyModalState() {
  const detailsOpen = ticketDetailsModal?.getAttribute("aria-hidden") === "false";
  const resolveOpen = resolveConfirmModal?.getAttribute("aria-hidden") === "false";
  const deleteOpen = deleteConfirmModal?.getAttribute("aria-hidden") === "false";
  document.body.classList.toggle("modal-open", detailsOpen || resolveOpen || deleteOpen);
}

function openTicketDetails(ticketId, sourceSection = "queue") {
  const ticket = tickets.find((entry) => entry.id === ticketId);
  if (!ticket || !ticketDetailsModal) {
    return;
  }

  currentDetailsSource = sourceSection;

  setDetailValue("detailTicketId", ticket.id);
  setDetailValue("detailName", ticket.name);
  setDetailValue("detailEmail", ticket.email);
  setDetailValue("detailSubject", ticket.subject);
  setDetailValue("detailCreatedAt", formatDate(ticket.createdAt));
  setDetailValue("detailCategory", ticket.category);
  setDetailValue("detailPriority", ticket.priority.toUpperCase());
  setDetailValue("detailStatus", formatStatus(ticket.status).toUpperCase());
  setDetailValue("detailUpdatedAt", ticket.updatedAt ? formatDate(ticket.updatedAt) : "Not updated yet");
  setDetailValue("detailMessage", ticket.message);
  const canDelete = canDeleteTickets && currentDetailsSource === "history" && ticket.status === "resolved";
  if (detailActions) {
    detailActions.hidden = !canDelete;
  }
  if (deleteTicketFromDetailsButton) {
    deleteTicketFromDetailsButton.hidden = !canDelete;
    deleteTicketFromDetailsButton.dataset.ticketId = canDelete ? ticket.id : "";
    deleteTicketFromDetailsButton.style.display = canDelete ? "inline-flex" : "none";
  }

  ticketDetailsModal.setAttribute("aria-hidden", "false");
  syncBodyModalState();
}

function closeTicketDetails() {
  if (!ticketDetailsModal) {
    return;
  }

  ticketDetailsModal.setAttribute("aria-hidden", "true");
  if (detailActions) {
    detailActions.hidden = true;
  }
  if (deleteTicketFromDetailsButton) {
    deleteTicketFromDetailsButton.hidden = true;
    deleteTicketFromDetailsButton.dataset.ticketId = "";
    deleteTicketFromDetailsButton.style.display = "none";
  }
  currentDetailsSource = "queue";
  syncBodyModalState();
}

function openResolveConfirm(ticketId, previousStatus, nextStatus) {
  const ticket = tickets.find((entry) => entry.id === ticketId);
  if (!ticket || !resolveConfirmModal) {
    return;
  }

  pendingResolution = {
    ticketId,
    previousStatus,
    nextStatus,
  };

  resolveConfirmCopy.textContent = `${ticket.id} will be marked as resolved and moved from Ticket Queue to Recent Ticket History.`;
  resolveConfirmModal.setAttribute("aria-hidden", "false");
  syncBodyModalState();
}

function closeResolveConfirm() {
  if (!resolveConfirmModal) {
    return;
  }

  resolveConfirmModal.setAttribute("aria-hidden", "true");
  pendingResolution = null;
  syncBodyModalState();
}

function openDeleteConfirm(ticketId) {
  const ticket = tickets.find((entry) => entry.id === ticketId);
  if (!ticket || !deleteConfirmModal) {
    return;
  }

  pendingDeletion = {
    ticketId,
  };

  deleteConfirmCopy.textContent = `${ticket.id} will be permanently removed from Recent Ticket History. This cannot be undone.`;
  deleteConfirmModal.setAttribute("aria-hidden", "false");
  syncBodyModalState();
}

function closeDeleteConfirm() {
  if (!deleteConfirmModal) {
    return;
  }

  deleteConfirmModal.setAttribute("aria-hidden", "true");
  pendingDeletion = null;
  syncBodyModalState();
}

function resetStatusSelect(ticketId, status) {
  const select = tableBody.querySelector(`.status-select[data-ticket-id="${ticketId}"]`);
  if (select instanceof HTMLSelectElement) {
    select.value = status;
  }
}

async function saveStatus(ticketId, status) {
  const response = await fetch(`/tickets/${ticketId}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({ status }),
  });

  if (response.redirected || response.headers.get("content-type")?.includes("text/html")) {
    redirectToLogin();
    return null;
  }

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  upsertTicket(payload.ticket);
  return payload.ticket;
}

async function deleteResolvedTicket(ticketId) {
  const response = await fetch(`/tickets/${ticketId}`, {
    method: "DELETE",
    headers: {
      "x-csrf-token": csrfToken,
    },
  });

  if (response.redirected || response.headers.get("content-type")?.includes("text/html")) {
    redirectToLogin();
    return null;
  }

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  removeTicket(ticketId);
  return payload.ticket;
}

function redirectToLogin() {
  window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
}

enableNotificationsButton?.addEventListener("click", async () => {
  const result = await Notification.requestPermission();
  if (result === "granted") {
    showToast("Browser alerts enabled", "You will now receive a notification when a ticket is created.");
  }
});

tableBody.addEventListener("change", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement) || !target.classList.contains("status-select")) {
    return;
  }

  const ticketId = target.dataset.ticketId;
  const previousStatus = target.dataset.currentStatus || "new";
  const nextStatus = target.value;

  if (nextStatus === previousStatus) {
    return;
  }

  if (nextStatus === "resolved") {
    resetStatusSelect(ticketId, previousStatus);
    openResolveConfirm(ticketId, previousStatus, nextStatus);
    return;
  }

  const updatedTicket = await saveStatus(ticketId, nextStatus);

  if (!updatedTicket) {
    resetStatusSelect(ticketId, previousStatus);
    showToast("Update failed", "The ticket status could not be saved.");
    return;
  }

  showToast("Status updated", `${updatedTicket.id} is now marked as ${updatedTicket.status.replace("_", " ")}.`);
});

tableBody.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const button = target.closest(".view-details-button");
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  openTicketDetails(button.dataset.ticketId, "queue");
});

historyBody.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const button = target.closest(".view-details-button");
  if (button instanceof HTMLButtonElement) {
    openTicketDetails(button.dataset.ticketId, "history");
    return;
  }
});

closeTicketDetailsButton?.addEventListener("click", closeTicketDetails);

deleteTicketFromDetailsButton?.addEventListener("click", async () => {
  if (!canDeleteTickets) {
    return;
  }

  const ticketId = deleteTicketFromDetailsButton.dataset.ticketId;
  if (!ticketId) {
    return;
  }

  openDeleteConfirm(ticketId);
});

ticketDetailsModal?.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.dataset.closeModal === "true") {
    closeTicketDetails();
  }
});

cancelResolveTopButton?.addEventListener("click", closeResolveConfirm);
cancelResolveButton?.addEventListener("click", closeResolveConfirm);

resolveConfirmModal?.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.dataset.closeResolveModal === "true") {
    closeResolveConfirm();
  }
});

cancelDeleteTopButton?.addEventListener("click", closeDeleteConfirm);
cancelDeleteButton?.addEventListener("click", closeDeleteConfirm);

deleteConfirmModal?.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.dataset.closeDeleteModal === "true") {
    closeDeleteConfirm();
  }
});

confirmResolveButton?.addEventListener("click", async () => {
  if (!pendingResolution) {
    return;
  }

  const { ticketId, previousStatus, nextStatus } = pendingResolution;
  const updatedTicket = await saveStatus(ticketId, nextStatus);

  if (!updatedTicket) {
    resetStatusSelect(ticketId, previousStatus);
    closeResolveConfirm();
    showToast("Update failed", "The ticket status could not be saved.");
    return;
  }

  closeResolveConfirm();
  showToast("Ticket resolved", `${updatedTicket.id} moved to Recent Ticket History.`);
});

confirmDeleteButton?.addEventListener("click", async () => {
  if (!canDeleteTickets) {
    return;
  }

  if (!pendingDeletion) {
    return;
  }

  const { ticketId } = pendingDeletion;
  const deletedTicket = await deleteResolvedTicket(ticketId);
  if (!deletedTicket) {
    closeDeleteConfirm();
    showToast("Delete failed", "The resolved ticket could not be deleted.");
    return;
  }

  closeDeleteConfirm();
  closeTicketDetails();
  showToast("Ticket deleted", `${deletedTicket.id} was removed from Recent Ticket History.`);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeTicketDetails();
    closeResolveConfirm();
    closeDeleteConfirm();
  }
});

socket.on("tickets:init", (payload) => {
  tickets = payload.tickets || [];
  renderRows();
});

socket.on("ticket:new", (ticket) => {
  upsertTicket(ticket);
  showToast("New support ticket", `${ticket.id} from ${ticket.name}`);
  maybeNotify(ticket);
});

socket.on("ticket:updated", (ticket) => {
  upsertTicket(ticket);
});

socket.on("connect_error", (error) => {
  if (error?.message === "Unauthorized") {
    redirectToLogin();
  }
});

renderRows();
