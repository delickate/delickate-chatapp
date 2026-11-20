<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Conversation;
use App\Models\FriendRequest;
use App\Models\Message;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\ValidationException;

class ConversationController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $userId = (int) $request->user()->id;
        $conversations = Conversation::query()
            ->where(function ($query) use ($userId) {
                $query->where(function ($direct) use ($userId) {
                    $direct->where('type', 'direct')
                        ->where(fn ($pair) => $pair->where('low_user_id', $userId)
                            ->orWhere('high_user_id', $userId));
                })->orWhereHas('participants', fn ($participants) => $participants->where('users.id', $userId));
            })
            ->with([
                'lowUser:id,name,phone',
                'highUser:id,name,phone',
                'participants:id,name,phone',
                'messages' => fn ($query) => $query->with('sender:id,name')->latest('id')->limit(1),
            ])
            ->withCount([
                'messages as unread_count' => fn ($query) => $query
                    ->where('sender_id', '!=', $userId)
                    ->whereNull('read_at'),
            ])
            ->orderByDesc('updated_at')
            ->paginate(50);

        $conversations->getCollection()->transform(
            fn (Conversation $conversation) => $this->conversationData($conversation, $userId)
        );

        return response()->json($conversations);
    }

    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'friend_id' => ['required', 'integer', 'exists:users,id'],
        ]);
        $userId = (int) $request->user()->id;
        $friendId = (int) $validated['friend_id'];

        if ($userId === $friendId) {
            throw ValidationException::withMessages(['friend_id' => ['You cannot start a conversation with yourself.']]);
        }

        $lowId = min($userId, $friendId);
        $highId = max($userId, $friendId);
        $isFriend = FriendRequest::where('low_user_id', $lowId)
            ->where('high_user_id', $highId)
            ->where('status', 'accepted')
            ->exists();

        if (! $isFriend) {
            return response()->json(['message' => 'You can only message accepted friends.'], 403);
        }

        $conversation = Conversation::firstOrCreate([
            'type' => 'direct',
            'low_user_id' => $lowId,
            'high_user_id' => $highId,
            'direct_key' => $lowId.':'.$highId,
        ]);

        $conversation->load([
            'lowUser:id,name,phone',
            'highUser:id,name,phone',
            'messages' => fn ($query) => $query->with('sender:id,name')->latest('id')->limit(1),
        ])->loadCount([
            'messages as unread_count' => fn ($query) => $query
                ->where('sender_id', '!=', $userId)
                ->whereNull('read_at'),
        ]);

        return response()->json($this->conversationData($conversation, $userId), 201);
    }

    public function createGroup(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'name' => ['required', 'string', 'min:1', 'max:100'],
            'friend_ids' => ['required', 'array', 'min:1', 'max:50'],
            'friend_ids.*' => ['required', 'integer', 'distinct', 'exists:users,id'],
        ]);
        $userId = (int) $request->user()->id;
        $friendIds = array_map('intval', $validated['friend_ids']);
        $name = trim($validated['name']);

        if ($name === '') {
            throw ValidationException::withMessages([
                'name' => ['Enter a group title.'],
            ]);
        }

        if (in_array($userId, $friendIds, true)) {
            throw ValidationException::withMessages([
                'friend_ids' => ['You are already included in the group.'],
            ]);
        }

        $acceptedIds = FriendRequest::query()
            ->where('status', 'accepted')
            ->where(function ($query) use ($userId, $friendIds) {
                $query->where(fn ($pair) => $pair
                    ->where('low_user_id', $userId)
                    ->whereIn('high_user_id', $friendIds))
                    ->orWhere(fn ($pair) => $pair
                        ->where('high_user_id', $userId)
                        ->whereIn('low_user_id', $friendIds));
            })
            ->get(['low_user_id', 'high_user_id'])
            ->map(fn (FriendRequest $friendship) => (int) $friendship->low_user_id === $userId
                ? (int) $friendship->high_user_id
                : (int) $friendship->low_user_id)
            ->all();

        foreach ($friendIds as $friendId) {
            if (! in_array($friendId, $acceptedIds, true)) {
                throw ValidationException::withMessages([
                    'friend_ids' => ['All group members must be accepted friends.'],
                ]);
            }
        }

        $conversation = DB::transaction(function () use ($name, $userId, $friendIds) {
            $conversation = Conversation::create([
                'type' => 'group',
                'name' => $name,
                'created_by' => $userId,
                'low_user_id' => $userId,
                'high_user_id' => $userId,
                'direct_key' => null,
            ]);
            $conversation->participants()->attach(array_merge([$userId], $friendIds));

            return $conversation;
        });

        $conversation->load([
            'lowUser:id,name,phone',
            'highUser:id,name,phone',
            'participants:id,name,phone',
            'messages' => fn ($query) => $query->with('sender:id,name')->latest('id')->limit(1),
        ])->setAttribute('unread_count', 0);

        return response()->json($this->conversationData($conversation, $userId), 201);
    }

    public function leaveGroup(Request $request, Conversation $conversation): JsonResponse
    {
        $userId = (int) $request->user()->id;
        if (! $conversation->isGroup()) {
            return response()->json(['message' => 'Group not found.'], 404);
        }
        if ((int) $conversation->created_by === $userId) {
            return response()->json(['message' => 'The group creator cannot leave the group.'], 403);
        }
        if (! $conversation->includesUser($userId)) {
            return response()->json(['message' => 'Group not found.'], 404);
        }

        $conversation->participants()->detach($userId);

        return response()->json(['message' => 'You left the group.']);
    }

    public function removeGroupMember(Request $request, Conversation $conversation, int $userId): JsonResponse
    {
        $actorId = (int) $request->user()->id;
        if (! $conversation->isGroup()) {
            return response()->json(['message' => 'Group not found.'], 404);
        }
        if ((int) $conversation->created_by !== $actorId) {
            return response()->json(['message' => 'Only the group creator can remove members.'], 403);
        }
        if ($userId === $actorId) {
            throw ValidationException::withMessages([
                'user_id' => ['The group creator cannot remove themselves.'],
            ]);
        }
        if (! $conversation->includesUser($userId)) {
            return response()->json(['message' => 'Group member not found.'], 404);
        }

        $conversation->participants()->detach($userId);

        return response()->json(['message' => 'Group member removed.']);
    }

    public function socketAccess(Request $request, Conversation $conversation): JsonResponse
    {
        $userId = (int) $request->user()->id;

        if (! $conversation->includesUser($userId)) {
            return response()->json(['message' => 'Conversation not found.'], 404);
        }

        $peerId = $conversation->isGroup()
            ? null
            : ($userId === (int) $conversation->low_user_id
                ? (int) $conversation->high_user_id
                : (int) $conversation->low_user_id);

        return response()->json([
            'conversation_id' => $conversation->id,
            'peer_id' => $peerId,
            'type' => $conversation->type,
        ]);
    }

    public function messages(Request $request, Conversation $conversation): JsonResponse
    {
        $userId = (int) $request->user()->id;

        if (! $conversation->includesUser($userId)) {
            return response()->json(['message' => 'Conversation not found.'], 404);
        }

        $messages = $conversation->messages()
            ->with(['sender:id,name,phone', 'conversation.participants:id,name,phone'])
            ->orderByDesc('id')
            ->paginate(50);
        $messages->getCollection()->transform(fn (Message $message) => $this->messageData($message, $userId));

        return response()->json($messages);
    }

    public function send(Request $request, Conversation $conversation): JsonResponse
    {
        $userId = (int) $request->user()->id;

        if (! $conversation->includesUser($userId)) {
            return response()->json(['message' => 'Conversation not found.'], 404);
        }

        $validated = $request->validate([
            'body' => ['required_without:attachment', 'nullable', 'string', 'max:10000'],
            'attachment' => ['required_without:body', 'nullable', 'file', 'max:5120'],
            'type' => ['sometimes', 'in:text'],
        ]);

        $file = $request->file('attachment');
        $attachment = $file ? $this->validatedAttachment($file) : null;
        $storedPath = null;

        try {
            $message = DB::transaction(function () use ($conversation, $userId, $validated, $file, $attachment, &$storedPath) {
                $message = $conversation->messages()->create([
                    'sender_id' => $userId,
                    'body' => $validated['body'] ?? null,
                    'type' => $file ? 'file' : 'text',
                    'attachment_name' => $attachment['name'] ?? null,
                    'attachment_mime' => $attachment['mime'] ?? null,
                    'attachment_size' => $file?->getSize(),
                ]);

                if ($file) {
                    $storedPath = $file->store(
                        "messages/{$conversation->id}",
                        ['disk' => 'private']
                    );
                    $message->attachment_path = $storedPath;
                    $message->save();
                }

                $conversation->touch();

                return $message;
            });
        } catch (\Throwable $exception) {
            if ($storedPath) {
                Storage::disk('private')->delete($storedPath);
            }

            throw $exception;
        }

        $message->load('sender:id,name,phone');

        return response()->json($this->messageData($message), 201);
    }

    public function downloadAttachment(Request $request, Conversation $conversation, Message $message)
    {
        $userId = (int) $request->user()->id;

        if (! $conversation->includesUser($userId)
            || (int) $message->conversation_id !== (int) $conversation->id
            || ! $message->attachment_path) {
            return response()->json(['message' => 'Attachment not found.'], 404);
        }

        $extension = pathinfo($message->attachment_name, PATHINFO_EXTENSION);
        $filename = 'attachment-'.$message->id.($extension ? '.'.$extension : '');

        return Storage::disk('private')->download($message->attachment_path, $filename, [
            'Content-Type' => $message->attachment_mime,
            'X-Content-Type-Options' => 'nosniff',
            'Cache-Control' => 'private, no-store',
        ]);
    }

    public function markDelivered(Request $request, Conversation $conversation): JsonResponse
    {
        return $this->updateReceipt($request, $conversation, 'delivered_at');
    }

    public function markRead(Request $request, Conversation $conversation): JsonResponse
    {
        return $this->updateReceipt($request, $conversation, 'read_at');
    }

    private function updateReceipt(Request $request, Conversation $conversation, string $column): JsonResponse
    {
        $userId = (int) $request->user()->id;

        if (! $conversation->includesUser($userId)) {
            return response()->json(['message' => 'Conversation not found.'], 404);
        }

        if ($conversation->isGroup()) {
            $participant = $conversation->participants()
                ->where('users.id', $userId)
                ->firstOrFail();
            $previous = $column === 'read_at'
                ? $participant->pivot->last_read_at
                : $participant->pivot->last_delivered_at;
            $incoming = $conversation->messages()->where('sender_id', '!=', $userId);
            if ($previous) {
                $incoming->where('created_at', '>', $previous);
            }
            $updated = $incoming->count();
            $now = now();
            $conversation->participants()->updateExistingPivot($userId, [
                ($column === 'read_at' ? 'last_read_at' : 'last_delivered_at') => $now,
                ...($column === 'read_at' ? ['last_delivered_at' => $now] : []),
                'updated_at' => $now,
            ]);

            return response()->json([
                'updated_count' => $updated,
                $column => $now->toISOString(),
            ]);
        }

        if ($column === 'read_at') {
            [$updated, $now] = DB::transaction(function () use ($conversation, $userId) {
                $now = now();
                $incoming = $conversation->messages()->where('sender_id', '!=', $userId);
                $incoming->whereNull('read_at')->whereNull('delivered_at')->update([
                    'delivered_at' => $now,
                    'updated_at' => $now,
                ]);

                $updated = $conversation->messages()
                    ->where('sender_id', '!=', $userId)
                    ->whereNull('read_at')
                    ->update(['read_at' => $now, 'updated_at' => $now]);

                return [$updated, $now];
            });
        } else {
            $now = now();
            $updated = $conversation->messages()
                ->where('sender_id', '!=', $userId)
                ->whereNull($column)
                ->update([
                    $column => $now,
                    'updated_at' => $now,
                ]);
        }

        return response()->json([
            'updated_count' => $updated,
            $column => $now->toISOString(),
        ]);
    }

    private function conversationData(Conversation $conversation, int $userId): array
    {
        $otherUser = $conversation->isGroup()
            ? null
            : ((int) $conversation->low_user_id === $userId
                ? $conversation->highUser
                : $conversation->lowUser);
        $lastMessage = $conversation->messages->first();
        $unreadCount = $conversation->unread_count ?? 0;
        if ($conversation->isGroup()) {
            $participant = $conversation->participants->firstWhere('id', $userId);
            $unread = $conversation->messages()->where('sender_id', '!=', $userId);
            if ($participant?->pivot?->last_read_at) {
                $unread->where('created_at', '>', $participant->pivot->last_read_at);
            }
            $unreadCount = $unread->count();
        }

        return [
            'id' => $conversation->id,
            'type' => $conversation->type ?? 'direct',
            'name' => $conversation->name,
            'created_by' => $conversation->created_by,
            'friend' => $otherUser ? [
                'id' => $otherUser->id,
                'name' => $otherUser->name,
                'phone' => $otherUser->phone,
            ] : null,
            'participants' => $conversation->isGroup()
                ? $conversation->participants->map(fn ($participant) => [
                    'id' => $participant->id,
                    'name' => $participant->name,
                    'phone' => $participant->phone,
                ])->values()
                : [],
            'last_message' => $lastMessage ? $this->messageData($lastMessage) : null,
            'unread_count' => $unreadCount,
            'created_at' => $conversation->created_at,
            'updated_at' => $conversation->updated_at,
        ];
    }

    private function messageData(Message $message, ?int $userId = null): array
    {
        $readAt = $message->read_at;
        $deliveredAt = $message->delivered_at;
        if ($message->conversation?->isGroup()) {
            $participants = $message->conversation->relationLoaded('participants')
                ? $message->conversation->participants
                : $message->conversation->participants()->get();
            $recipients = $participants->reject(
                fn ($participant) => (int) $participant->id === (int) $message->sender_id
            );
            $allRecipientsRead = $recipients->isNotEmpty() && $recipients->every(
                fn ($participant) => $participant->pivot->last_read_at
                    && $message->created_at->lte($participant->pivot->last_read_at)
            );

            if ($allRecipientsRead) {
                $readAt = $recipients
                    ->map(fn ($participant) => $participant->pivot->last_read_at)
                    ->max();
            } else {
                $readAt = null;
            }
        }

        return [
            'id' => $message->id,
            'conversation_id' => $message->conversation_id,
            'sender' => [
                'id' => $message->sender->id,
                'name' => $message->sender->name,
            ],
            'body' => $message->body,
            'type' => $message->type,
            'attachment' => $message->attachment_path ? [
                'name' => $message->attachment_name,
                'mime' => $message->attachment_mime,
                'size' => $message->attachment_size,
            ] : null,
            'created_at' => $message->created_at,
            'delivered_at' => $deliveredAt,
            'read_at' => $readAt,
        ];
    }

    private function validatedAttachment(\Illuminate\Http\UploadedFile $file): array
    {
        $extension = strtolower($file->getClientOriginalExtension());
        $allowed = [
            'jpg' => ['image/jpeg', IMAGETYPE_JPEG],
            'jpeg' => ['image/jpeg', IMAGETYPE_JPEG],
            'jpe' => ['image/jpeg', IMAGETYPE_JPEG],
            'jfif' => ['image/jpeg', IMAGETYPE_JPEG],
            'png' => ['image/png', IMAGETYPE_PNG],
            'gif' => ['image/gif', IMAGETYPE_GIF],
            'webp' => ['image/webp', IMAGETYPE_WEBP],
            'bmp' => ['image/bmp', IMAGETYPE_BMP],
            'dib' => ['image/bmp', IMAGETYPE_BMP],
            'tif' => ['image/tiff', [IMAGETYPE_TIFF_II, IMAGETYPE_TIFF_MM]],
            'tiff' => ['image/tiff', [IMAGETYPE_TIFF_II, IMAGETYPE_TIFF_MM]],
            'ico' => ['image/vnd.microsoft.icon', IMAGETYPE_ICO],
            'avif' => ['image/avif', IMAGETYPE_AVIF],
            'heic' => ['image/heic', 'heif'],
            'heif' => ['image/heif', 'heif'],
            'pdf' => ['application/pdf', '%PDF-'],
            'txt' => ['text/plain', null],
            'rtf' => ['application/rtf', '{\\rtf'],
            'doc' => ['application/msword', "\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1"],
            'dot' => ['application/msword', "\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1"],
            'docm' => ['application/vnd.ms-word.document.macroEnabled.12', "PK\x03\x04"],
            'docx' => ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', "PK\x03\x04"],
            'dotm' => ['application/vnd.ms-word.template.macroEnabled.12', "PK\x03\x04"],
            'dotx' => ['application/vnd.openxmlformats-officedocument.wordprocessingml.template', "PK\x03\x04"],
            'odt' => ['application/vnd.oasis.opendocument.text', "PK\x03\x04"],
            'ppt' => ['application/vnd.ms-powerpoint', "\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1"],
            'pot' => ['application/vnd.ms-powerpoint', "\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1"],
            'pps' => ['application/vnd.ms-powerpoint', "\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1"],
            'pptm' => ['application/vnd.ms-powerpoint.presentation.macroEnabled.12', "PK\x03\x04"],
            'pptx' => ['application/vnd.openxmlformats-officedocument.presentationml.presentation', "PK\x03\x04"],
            'ppsx' => ['application/vnd.openxmlformats-officedocument.presentationml.slideshow', "PK\x03\x04"],
            'odp' => ['application/vnd.oasis.opendocument.presentation', "PK\x03\x04"],
            'xls' => ['application/vnd.ms-excel', "\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1"],
            'xlt' => ['application/vnd.ms-excel', "\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1"],
            'xlsx' => ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', "PK\x03\x04"],
            'xlsm' => ['application/vnd.ms-excel.sheet.macroEnabled.12', "PK\x03\x04"],
            'xlsb' => ['application/vnd.ms-excel.sheet.binary.macroEnabled.12', "PK\x03\x04"],
            'xltm' => ['application/vnd.ms-excel.template.macroEnabled.12', "PK\x03\x04"],
            'xltx' => ['application/vnd.openxmlformats-officedocument.spreadsheetml.template', "PK\x03\x04"],
            'csv' => ['text/csv', null],
            'ods' => ['application/vnd.oasis.opendocument.spreadsheet', "PK\x03\x04"],
            'zip' => ['application/zip', "PK\x03\x04"],
        ];

        if (! isset($allowed[$extension])) {
            throw ValidationException::withMessages([
                'attachment' => ['Only images, documents, spreadsheets, and ZIP files are allowed.'],
            ]);
        }

        $contents = file_get_contents($file->getRealPath());

        if ($contents === false) {
            throw ValidationException::withMessages([
                'attachment' => ['The attachment could not be read. Please try selecting it again.'],
            ]);
        }

        $imageType = $allowed[$extension][1];
        if (is_int($imageType) || is_array($imageType)) {
            $image = @getimagesize($file->getRealPath());
            $valid = $image !== false
                && in_array($image[2], (array) $imageType, true)
                && str_starts_with($image['mime'] ?? '', 'image/');
        } elseif ($imageType === 'heif') {
            $brand = substr($contents, 8, 4);
            $valid = strlen($contents) >= 12
                && substr($contents, 4, 4) === 'ftyp'
                && in_array($brand, ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'], true);
        } elseif ($extension === 'txt' || $extension === 'csv') {
            $valid = ! str_contains($contents, "\0");
        } elseif ($extension === 'zip') {
            $valid = str_starts_with($contents, "PK\x03\x04") || str_starts_with($contents, "PK\x05\x06");
        } else {
            $valid = str_starts_with($contents, $imageType);
        }

        if (! $valid) {
            throw ValidationException::withMessages([
                'attachment' => ['The attachment content does not match an allowed file type.'],
            ]);
        }

        $originalName = basename(str_replace('\\', '/', $file->getClientOriginalName()));
        $stem = preg_replace('/[^A-Za-z0-9_-]/', '_', pathinfo($originalName, PATHINFO_FILENAME));
        $stem = trim(substr($stem, 0, 240), '_-');

        return [
            'name' => ($stem ?: 'attachment').'.'.$extension,
            'mime' => $allowed[$extension][0],
        ];
    }

}
