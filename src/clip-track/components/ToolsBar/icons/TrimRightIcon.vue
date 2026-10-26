<template>
  <!-- 向右裁剪：左侧实条保留，右侧虚点表示裁掉 -->
  <svg
    width="1em"
    height="1em"
    viewBox="0 0 24 24"
    preserveAspectRatio="xMidYMid meet"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    role="presentation"
    xmlns="http://www.w3.org/2000/svg"
    class="trim-right-icon"
  >
    <path d="M6 4h4v16H6" />
    <circle cx="17.5" cy="4" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="14" cy="4" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="14" cy="7.2" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="14" cy="10.4" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="14" cy="13.6" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="14" cy="16.8" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="14" cy="20" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="17.5" cy="20" r="0.8" fill="currentColor" stroke="none" />
  </svg>
</template>

<style scoped>
.trim-right-icon {
  display: inline-block;
  vertical-align: middle;
}
</style>
