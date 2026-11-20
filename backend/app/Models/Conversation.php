<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

class Conversation extends Model
{
    protected $fillable = [
        'low_user_id',
        'high_user_id',
        'type',
        'name',
        'created_by',
        'direct_key',
    ];

    public function messages(): HasMany
    {
        return $this->hasMany(Message::class);
    }

    public function lowUser(): BelongsTo
    {
        return $this->belongsTo(User::class, 'low_user_id');
    }

    public function highUser(): BelongsTo
    {
        return $this->belongsTo(User::class, 'high_user_id');
    }

    public function creator(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    public function participants(): BelongsToMany
    {
        return $this->belongsToMany(User::class, 'conversation_participants')
            ->withPivot(['last_delivered_at', 'last_read_at'])
            ->withTimestamps();
    }

    public function isGroup(): bool
    {
        return $this->type === 'group';
    }

    public function includesUser(int $userId): bool
    {
        if ($this->isGroup()) {
            return $this->participants()->where('users.id', $userId)->exists();
        }

        return in_array($userId, [(int) $this->low_user_id, (int) $this->high_user_id], true);
    }
}
