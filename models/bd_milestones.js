module.exports = (sequelize, DataTypes) => {
  const BusinessDevelopmentMilestones = sequelize.define(
    "bd_milestones",
    {
      bd_entry_id: {
        type: DataTypes.UUID,
        primaryKey: true,
        references: {
          model: "bd_table",
          key: "bd_entry_id",
        },
      },
      milestone_id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      milestone_name: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      milestone_date: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      milestone_status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: "in-progress",
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      timestamps: true,
      freezeTableName: true,
    }
  );
  return BusinessDevelopmentMilestones;
};


