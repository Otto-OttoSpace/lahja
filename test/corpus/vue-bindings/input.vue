<template>
  <div>
    <input :placeholder="msg" />
    <input placeholder="Search" />
    <label>Full name</label>
    <button v-bind:title="tip">Save</button>
  </div>
</template>
<script setup lang="ts">
const msg = 'dynamic';
const heading = 'Account settings';
</script>
