<template>
  <!-- 向左裁剪：右侧实条保留，左侧虚点表示裁掉 -->
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
    class="trim-left-icon"
  >
    <path d="M18 4h-4v16h4" />
    <circle cx="6.5" cy="4" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="10" cy="4" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="10" cy="7.2" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="10" cy="10.4" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="10" cy="13.6" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="10" cy="16.8" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="10" cy="20" r="0.8" fill="currentColor" stroke="none" />
    <circle cx="6.5" cy="20" r="0.8" fill="currentColor" stroke="none" />
  </svg>
</template>

<style scoped>
.trim-left-icon {
  display: inline-block;
  vertical-align: middle;
}
</style>
