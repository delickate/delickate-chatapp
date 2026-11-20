<?php

namespace Tests\Feature;

use App\Models\Conversation;
use App\Models\FriendRequest;
use App\Models\Message;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Laravel\Sanctum\Sanctum;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class ChatApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_user_can_register_and_log_in_with_phone(): void
    {
        $registration = $this->postJson('/api/auth/register', [
            'name' => 'Alex User',
            'phone' => '+15551234567',
            'email' => 'alex@example.com',
            'password' => 'secure-password',
            'dob' => '1995-04-12',
            'device_name' => 'test-device',
        ]);

        $registration
            ->assertCreated()
            ->assertJsonPath('user.phone', '+15551234567')
            ->assertJsonPath('user.dob', '1995-04-12')
            ->assertJsonStructure(['user' => ['id', 'name', 'phone', 'email', 'dob'], 'token']);

        $this->postJson('/api/auth/login', [
            'phone' => '+15551234567',
            'password' => 'secure-password',
        ])->assertOk()->assertJsonStructure(['user', 'token']);

        $this->postJson('/api/auth/login', [
            'phone' => '+15551234567',
            'password' => 'incorrect-password',
        ])->assertUnprocessable();
    }

    public function test_friends_can_accept_requests_and_send_messages_with_receipts(): void
    {
        $sender = User::factory()->create(['phone' => '+15551234567']);
        $recipient = User::factory()->create(['phone' => '+15557654321']);

        Sanctum::actingAs($sender);
        $requestResponse = $this->postJson('/api/friends/requests', [
            'phone' => $recipient->phone,
        ])->assertCreated()->assertJsonPath('status', 'pending');
        $requestId = $requestResponse->json('id');

        Sanctum::actingAs($recipient);
        $this->getJson('/api/friends/requests')
            ->assertOk()
            ->assertJsonPath('data.0.user.id', $sender->id);
        $this->postJson("/api/friends/requests/{$requestId}/accept")
            ->assertOk()
            ->assertJsonPath('status', 'accepted');

        $conversationId = $this->postJson('/api/conversations', [
            'friend_id' => $sender->id,
        ])->assertCreated()->json('id');

        Sanctum::actingAs($sender);
        $messageId = $this->postJson("/api/conversations/{$conversationId}/messages", [
            'body' => 'Hello there',
        ])->assertCreated()->assertJsonPath('body', 'Hello there')->json('id');

        Sanctum::actingAs($recipient);
        $this->getJson('/api/conversations')
            ->assertOk()
            ->assertJsonPath('data.0.unread_count', 1);
        $this->postJson("/api/conversations/{$conversationId}/delivered")
            ->assertOk()
            ->assertJsonPath('updated_count', 1);

        Sanctum::actingAs($sender);
        $secondMessageId = $this->postJson("/api/conversations/{$conversationId}/messages", [
            'body' => 'One more message',
        ])->assertCreated()->json('id');

        Sanctum::actingAs($recipient);
        $this->postJson("/api/conversations/{$conversationId}/read")
            ->assertOk()
            ->assertJsonPath('updated_count', 2);

        foreach ([$messageId, $secondMessageId] as $id) {
            $message = Message::findOrFail($id);
            $this->assertNotNull($message->delivered_at);
            $this->assertNotNull($message->read_at);
        }
    }

    public function test_unrelated_user_cannot_read_a_conversation(): void
    {
        $first = User::factory()->create();
        $second = User::factory()->create();
        $outsider = User::factory()->create();
        $conversation = Conversation::create([
            'low_user_id' => min($first->id, $second->id),
            'high_user_id' => max($first->id, $second->id),
        ]);

        Sanctum::actingAs($outsider);
        $this->getJson("/api/conversations/{$conversation->id}/messages")
            ->assertNotFound();
        $this->getJson("/api/conversations/{$conversation->id}/socket-access")
            ->assertNotFound();
    }

    public function test_socket_access_returns_the_other_conversation_participant(): void
    {
        [$sender, $recipient, $conversation] = $this->makeConversation();

        Sanctum::actingAs($sender);
        $this->getJson("/api/conversations/{$conversation->id}/socket-access")
            ->assertOk()
            ->assertJsonPath('conversation_id', $conversation->id)
            ->assertJsonPath('peer_id', $recipient->id);
    }

    public function test_friend_can_create_a_group_and_only_members_can_access_it(): void
    {
        $creator = User::factory()->create();
        $firstFriend = User::factory()->create();
        $secondFriend = User::factory()->create();
        $outsider = User::factory()->create();
        $this->acceptFriendship($creator, $firstFriend);
        $this->acceptFriendship($creator, $secondFriend);

        Sanctum::actingAs($creator);
        $group = $this->postJson('/api/groups', [
            'name' => 'Project team',
            'friend_ids' => [$firstFriend->id, $secondFriend->id],
        ])->assertCreated()
            ->assertJsonPath('type', 'group')
            ->assertJsonPath('name', 'Project team')
            ->assertJsonCount(3, 'participants')
            ->assertJsonPath('unread_count', 0);

        $conversationId = $group->json('id');
        $this->getJson('/api/conversations')
            ->assertOk()
            ->assertJsonPath('data.0.id', $conversationId)
            ->assertJsonPath('data.0.name', 'Project team');

        Sanctum::actingAs($outsider);
        $this->getJson("/api/conversations/{$conversationId}/messages")->assertNotFound();
        $this->getJson("/api/conversations/{$conversationId}/socket-access")->assertNotFound();

        Sanctum::actingAs($firstFriend);
        $this->getJson("/api/conversations/{$conversationId}/socket-access")
            ->assertOk()
            ->assertJsonPath('type', 'group')
            ->assertJsonPath('peer_id', null);
    }

    public function test_group_creation_requires_only_accepted_friends(): void
    {
        $creator = User::factory()->create();
        $friend = User::factory()->create();
        $notFriend = User::factory()->create();
        $this->acceptFriendship($creator, $friend);
        Sanctum::actingAs($creator);

        $this->postJson('/api/groups', [
            'name' => 'Invalid group',
            'friend_ids' => [$friend->id, $notFriend->id],
        ])->assertUnprocessable()
            ->assertJsonValidationErrors('friend_ids');
    }

    public function test_only_creator_can_remove_members_and_other_members_can_leave(): void
    {
        $creator = User::factory()->create();
        $member = User::factory()->create();
        $anotherMember = User::factory()->create();
        $this->acceptFriendship($creator, $member);
        $this->acceptFriendship($creator, $anotherMember);

        Sanctum::actingAs($creator);
        $conversationId = $this->postJson('/api/groups', [
            'name' => 'Project team',
            'friend_ids' => [$member->id, $anotherMember->id],
        ])->assertCreated()->json('id');

        Sanctum::actingAs($member);
        $this->deleteJson("/api/groups/{$conversationId}/members/{$anotherMember->id}")
            ->assertForbidden();
        $this->postJson("/api/groups/{$conversationId}/leave")
            ->assertOk();
        $this->getJson("/api/conversations/{$conversationId}/messages")
            ->assertNotFound();

        Sanctum::actingAs($creator);
        $this->postJson("/api/groups/{$conversationId}/leave")
            ->assertForbidden();
        $this->deleteJson("/api/groups/{$conversationId}/members/{$creator->id}")
            ->assertUnprocessable()
            ->assertJsonValidationErrors('user_id');
        $this->deleteJson("/api/groups/{$conversationId}/members/{$anotherMember->id}")
            ->assertOk();

        Sanctum::actingAs($anotherMember);
        $this->getJson("/api/conversations/{$conversationId}/messages")
            ->assertNotFound();
    }

    public function test_group_messages_have_unread_counts_per_member(): void
    {
        $creator = User::factory()->create();
        $firstFriend = User::factory()->create();
        $secondFriend = User::factory()->create();
        $this->acceptFriendship($creator, $firstFriend);
        $this->acceptFriendship($creator, $secondFriend);

        Sanctum::actingAs($creator);
        $conversationId = $this->postJson('/api/groups', [
            'name' => 'Project team',
            'friend_ids' => [$firstFriend->id, $secondFriend->id],
        ])->assertCreated()->json('id');
        $this->postJson("/api/conversations/{$conversationId}/messages", [
            'body' => 'Group update',
        ])->assertCreated();

        Sanctum::actingAs($firstFriend);
        $this->getJson('/api/conversations')
            ->assertOk()
            ->assertJsonPath('data.0.unread_count', 1);
        $this->getJson("/api/conversations/{$conversationId}/messages")
            ->assertOk()
            ->assertJsonPath('data.0.body', 'Group update');
        $this->postJson("/api/conversations/{$conversationId}/read")
            ->assertOk()
            ->assertJsonPath('updated_count', 1);
        $this->getJson('/api/conversations')
            ->assertOk()
            ->assertJsonPath('data.0.unread_count', 0);

        Sanctum::actingAs($creator);
        $this->getJson("/api/conversations/{$conversationId}/messages")
            ->assertOk()
            ->assertJsonPath('data.0.read_at', null);

        Sanctum::actingAs($secondFriend);
        $this->getJson('/api/conversations')
            ->assertOk()
            ->assertJsonPath('data.0.unread_count', 1);
        $this->postJson("/api/conversations/{$conversationId}/read")
            ->assertOk()
            ->assertJsonPath('updated_count', 1);

        Sanctum::actingAs($creator);
        $allReadResponse = $this->getJson("/api/conversations/{$conversationId}/messages")
            ->assertOk();
        $this->assertNotNull($allReadResponse->json('data.0.read_at'));
    }

    public function test_friend_can_send_and_download_a_private_attachment(): void
    {
        Storage::fake('private');
        [$sender, $recipient, $conversation] = $this->makeConversation();
        Sanctum::actingAs($sender);

        $response = $this->post("/api/conversations/{$conversation->id}/messages", [
            'body' => 'Here is the document',
            'attachment' => UploadedFile::fake()->createWithContent(
                'report.pdf',
                "%PDF-1.4\nAttachment test\n%%EOF"
            ),
        ]);

        $response->assertCreated()
            ->assertJsonPath('body', 'Here is the document')
            ->assertJsonPath('type', 'file')
            ->assertJsonPath('attachment.name', 'report.pdf')
            ->assertJsonMissingPath('attachment.path');

        $message = Message::findOrFail($response->json('id'));
        Storage::disk('private')->assertExists($message->attachment_path);

        Sanctum::actingAs($recipient);
        $this->get("/api/conversations/{$conversation->id}/messages/{$message->id}/attachment")
            ->assertOk()
            ->assertHeader('X-Content-Type-Options', 'nosniff')
            ->assertHeader('Content-Disposition', 'attachment; filename=attachment-'.$message->id.'.pdf');
    }

    public function test_attachment_size_and_content_are_validated(): void
    {
        [$sender, , $conversation] = $this->makeConversation();
        Sanctum::actingAs($sender);

        $this->post("/api/conversations/{$conversation->id}/messages", [
            'attachment' => UploadedFile::fake()->create('oversized.pdf', 5121, 'application/pdf'),
        ])->assertUnprocessable()->assertJsonValidationErrors('attachment');

        $this->post("/api/conversations/{$conversation->id}/messages", [
            'attachment' => UploadedFile::fake()->createWithContent('fake.jpg', 'not a real jpeg'),
        ])->assertUnprocessable()->assertJsonValidationErrors('attachment');
    }

    public function test_supported_images_spreadsheets_and_zip_files_can_be_sent(): void
    {
        Storage::fake('private');
        [$sender, , $conversation] = $this->makeConversation();
        Sanctum::actingAs($sender);

        $files = [
            UploadedFile::fake()->createWithContent(
                'photo.png',
                base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=')
            ),
            UploadedFile::fake()->createWithContent('workbook.xlsx', "PK\x03\x04spreadsheet"),
            UploadedFile::fake()->createWithContent('archive.zip', "PK\x05\x06"),
        ];

        foreach ($files as $file) {
            $this->post("/api/conversations/{$conversation->id}/messages", [
                'attachment' => $file,
            ])->assertCreated()->assertJsonPath('type', 'file');
        }
    }

    public function test_unsupported_attachment_extensions_are_rejected(): void
    {
        [$sender, , $conversation] = $this->makeConversation();
        Sanctum::actingAs($sender);

        $this->post("/api/conversations/{$conversation->id}/messages", [
            'attachment' => UploadedFile::fake()->createWithContent('program.exe', 'MZ executable'),
        ])->assertUnprocessable()->assertJsonValidationErrors('attachment');
    }

    public function test_non_participant_cannot_download_an_attachment(): void
    {
        Storage::fake('private');
        [$sender, , $conversation] = $this->makeConversation();
        $path = 'messages/'.$conversation->id.'/private-file.pdf';
        Storage::disk('private')->put($path, "%PDF-1.4\nprivate\n%%EOF");
        $message = $conversation->messages()->create([
            'sender_id' => $sender->id,
            'body' => null,
            'type' => 'file',
            'attachment_path' => $path,
            'attachment_name' => 'private.pdf',
            'attachment_mime' => 'application/pdf',
            'attachment_size' => 24,
        ]);

        Sanctum::actingAs(User::factory()->create());
        $this->getJson("/api/conversations/{$conversation->id}/messages/{$message->id}/attachment")
            ->assertNotFound();
    }

    private function makeConversation(): array
    {
        $first = User::factory()->create();
        $second = User::factory()->create();
        $conversation = Conversation::create([
            'low_user_id' => min($first->id, $second->id),
            'high_user_id' => max($first->id, $second->id),
        ]);

        return [$first, $second, $conversation];
    }

    private function acceptFriendship(User $first, User $second): void
    {
        FriendRequest::create([
            'low_user_id' => min($first->id, $second->id),
            'high_user_id' => max($first->id, $second->id),
            'sender_id' => $first->id,
            'status' => 'accepted',
        ]);
    }
}
