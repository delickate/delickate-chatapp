<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use RuntimeException;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('conversations', function (Blueprint $table) {
            $table->string('type', 16)->default('direct');
            $table->string('name', 100)->nullable();
            $table->foreignId('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->string('direct_key', 42)->nullable();
        });

        DB::table('conversations')->orderBy('id')->chunkById(500, function ($conversations) {
            foreach ($conversations as $conversation) {
                DB::table('conversations')
                    ->where('id', $conversation->id)
                    ->update(['direct_key' => $conversation->low_user_id.':'.$conversation->high_user_id]);
            }
        });

        Schema::table('conversations', function (Blueprint $table) {
            $table->dropUnique(['low_user_id', 'high_user_id']);
            $table->unique('direct_key');
        });

        Schema::create('conversation_participants', function (Blueprint $table) {
            $table->id();
            $table->foreignId('conversation_id')->constrained()->cascadeOnDelete();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->timestamp('last_delivered_at')->nullable();
            $table->timestamp('last_read_at')->nullable();
            $table->timestamps();

            $table->unique(['conversation_id', 'user_id']);
        });
    }

    public function down(): void
    {
        if (DB::table('conversations')->where('type', 'group')->exists()) {
            throw new RuntimeException('Group conversations must be removed before rolling back this migration.');
        }

        Schema::dropIfExists('conversation_participants');
        Schema::table('conversations', function (Blueprint $table) {
            $table->dropUnique(['direct_key']);
            $table->dropConstrainedForeignId('created_by');
            $table->dropColumn(['type', 'name', 'direct_key']);
            $table->unique(['low_user_id', 'high_user_id']);
        });
    }
};
