export function canViewUnit(user,unit){
  return user.organizationIds.includes(unit.organizationId);
}
